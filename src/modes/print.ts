import { setupAgent, stopMcpServers, teardown, type RunFlags } from "../cli.js";
import type { AgentEvent } from "../core/events.js";

export type OutputFormat = "text" | "json";
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json"];

type PrintFlags = RunFlags & { outputFormat?: OutputFormat };

/** The one JSON object `--output-format json` prints (a single line on stdout). */
export interface PrintJsonResult {
  result: string;
  isError: boolean;
  error?: string;
  sessionId: string;
  model: string;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/** One stderr line per event kind that matters to a script reader. */
export function diagnostic(e: AgentEvent): string | undefined {
  switch (e.type) {
    case "tool-call":
      return `[tool] ${e.summary}`;
    case "tool-result":
      return e.isError ? `[tool error] ${e.output.slice(0, 200)}` : undefined;
    case "retry":
      return `[retry ${e.attempt}/${e.maxAttempts}] ${e.message.slice(0, 120)}`;
    case "failover":
      return `[failover] ${e.from} -> ${e.to}: ${e.message.slice(0, 120)}`;
    case "goal-check":
      return e.done ? `[goal complete] ${e.reason}` : `[goal continues ${e.turnsLeft}] ${e.reason}`;
    case "subagent-update":
      return e.status === "running" ? undefined : `[agent ${e.status}] ${e.description} (${e.toolCalls} tools, ${e.inputTokens + e.outputTokens} tok)`;
    case "error":
      return `error: ${e.message}`;
    default:
      return undefined;
  }
}

/**
 * Turns the event stream into stdout for scripts. `text` streams the assistant's
 * text as it arrives with exactly one newline after each message and at the end
 * (a message already ending in "\n" is not doubled); `json` buffers and emits one
 * object at the end. Diagnostics always go to stderr so stdout stays parseable.
 */
export function createPrintFormatter(format: OutputFormat, out: (s: string) => void, err: (s: string) => void) {
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 } as PrintJsonResult["usage"];
  let current = "";
  let lineOpen = false;
  let toolCalls = 0;
  const endMessage = () => {
    if (format === "text" && lineOpen) out("\n");
    if (current) messages.push(current.replace(/\n+$/, ""));
    lineOpen = false;
    current = "";
  };
  return {
    onEvent(e: AgentEvent): void {
      if (e.type === "text-delta" && e.text) {
        if (format === "text") out(e.text);
        else current += e.text;
        lineOpen = !e.text.endsWith("\n");
      } else if (e.type === "message-end") endMessage();
      else if (e.type === "usage") {
        usage.inputTokens += e.inputTokens;
        usage.outputTokens += e.outputTokens;
        if (e.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + e.costUsd;
      } else {
        if (e.type === "tool-call") toolCalls++;
        if (e.type === "error") errors.push(e.message);
        const line = diagnostic(e);
        if (line) err(`${line}\n`);
      }
    },
    /** Flush; returns true when the run hit an error. */
    finish(meta: { sessionId: string; model: string }): boolean {
      endMessage();
      const isError = errors.length > 0;
      if (format === "json") {
        const result: PrintJsonResult = { result: messages.join("\n\n"), isError, ...(isError ? { error: errors.join("\n") } : {}), ...meta, toolCalls, usage };
        out(`${JSON.stringify(result)}\n`);
      }
      return isError;
    },
  };
}

/**
 * Headless mode: run one prompt, print the result, exit. Permissions auto-deny
 * unless --yolo. This is the scriptable/CI surface (and what `/loop`
 * schedules) and the debugging escape hatch when the TUI misbehaves.
 */
export async function runPrint(flags: PrintFlags, prompt: string): Promise<void> {
  const setup = await setupAgent(flags, async () =>
    flags.yolo ? { kind: "allow" } : { kind: "deny", reason: "Non-interactive mode; re-run with --yolo to allow tools." },
  );
  for (const w of setup.warnings) process.stderr.write(`warning: ${w}\n`);

  if (setup.modelUnavailable) {
    process.stderr.write(`error: ${setup.modelUnavailable}\nNon-interactive mode needs a working model — pass -m provider/model-id or fix your config.\n`);
    process.exitCode = 1;
    await stopMcpServers(setup.mcpConnections);
    return;
  }

  const fmt = createPrintFormatter(flags.outputFormat ?? "text", (s) => process.stdout.write(s), (s) => process.stderr.write(s));
  try {
    for await (const event of setup.agent.send(prompt)) fmt.onEvent(event);
  } finally {
    if (fmt.finish({ sessionId: setup.sessionId, model: setup.agent.modelId })) process.exitCode = 1;
    await teardown(setup);
  }
}
