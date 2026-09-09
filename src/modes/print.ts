import { setupAgent, stopMcpServers } from "../cli.js";
import type { AgentEvent } from "../core/events.js";

export type OutputFormat = "text" | "json";
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json"];

interface PrintFlags {
  model?: string;
  yolo: boolean;
  continue: boolean;
  resume?: string;
  allowOutsideCwd: boolean;
  cwd?: string;
  mcp: boolean;
  outputFormat?: OutputFormat;
}

export interface PrintRunMeta {
  sessionId: string;
  model: string;
}

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

export interface PrintFormatter {
  onEvent(event: AgentEvent): void;
  /** Flush; returns true when the run hit an error. */
  finish(meta: PrintRunMeta): boolean;
}

/**
 * Turns the event stream into stdout for scripts. `text` streams the assistant's
 * text as it arrives and guarantees exactly one newline after each message and
 * at the end (a message that already ends in "\n" is not doubled). `json`
 * buffers and emits one object at the end. Diagnostics (tool calls, retries,
 * errors) always go to stderr so stdout stays parseable.
 */
export function createPrintFormatter(
  format: OutputFormat,
  out: (s: string) => void,
  err: (s: string) => void,
): PrintFormatter {
  const messages: string[] = [];
  let current = "";
  let lineOpen = false;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  const errors: string[] = [];

  const endMessage = () => {
    if (format === "text") {
      if (lineOpen) out("\n");
      lineOpen = false;
    } else if (current) {
      messages.push(current.replace(/\n+$/, ""));
    }
    current = "";
  };

  return {
    onEvent(event) {
      switch (event.type) {
        case "text-delta":
          if (!event.text) break;
          if (format === "text") {
            out(event.text);
            lineOpen = !event.text.endsWith("\n");
          } else {
            current += event.text;
          }
          break;
        case "message-end":
          endMessage();
          break;
        case "tool-call":
          toolCalls++;
          err(`[tool] ${event.summary}\n`);
          break;
        case "tool-result":
          if (event.isError) err(`[tool error] ${event.output.slice(0, 200)}\n`);
          break;
        case "usage":
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
          break;
        case "retry":
          err(`[retry ${event.attempt}/${event.maxAttempts}] ${event.message.slice(0, 120)}\n`);
          break;
        case "failover":
          err(`[failover] ${event.from} -> ${event.to}: ${event.message.slice(0, 120)}\n`);
          break;
        case "goal-check":
          err(event.done ? `[goal complete] ${event.reason}\n` : `[goal continues ${event.turnsLeft}] ${event.reason}\n`);
          break;
        case "subagent-update":
          if (event.status !== "running") {
            err(
              `[agent ${event.status}] ${event.description} (${event.toolCalls} tools, ${event.inputTokens + event.outputTokens} tok)\n`,
            );
          }
          break;
        case "error":
          errors.push(event.message);
          err(`error: ${event.message}\n`);
          break;
        default:
          break;
      }
    },
    finish(meta) {
      endMessage();
      if (format === "json") {
        const result: PrintJsonResult = {
          result: messages.join("\n\n"),
          isError: errors.length > 0,
          ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
          sessionId: meta.sessionId,
          model: meta.model,
          toolCalls,
          usage: { inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) },
        };
        out(`${JSON.stringify(result)}\n`);
      }
      return errors.length > 0;
    },
  };
}

/**
 * Headless mode: run one prompt, print the result, exit. Permissions
 * auto-deny unless --yolo. This is the scriptable/CI surface (and what
 * `/loop` schedules) and the debugging escape hatch when the TUI misbehaves.
 */
export async function runPrint(flags: PrintFlags, prompt: string): Promise<void> {
  const setup = await setupAgent(flags, async () =>
    flags.yolo ? { kind: "allow" } : { kind: "deny", reason: "Non-interactive mode; re-run with --yolo to allow tools." },
  );
  for (const w of setup.warnings) process.stderr.write(`warning: ${w}\n`);

  if (setup.modelUnavailable) {
    process.stderr.write(
      `error: ${setup.modelUnavailable}\nNon-interactive mode needs a working model — pass -m provider/model-id or fix your config.\n`,
    );
    process.exitCode = 1;
    await stopMcpServers(setup.mcpConnections);
    return;
  }

  const fmt = createPrintFormatter(
    flags.outputFormat ?? "text",
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
  );
  try {
    for await (const event of setup.agent.send(prompt)) fmt.onEvent(event);
  } finally {
    if (fmt.finish({ sessionId: setup.sessionId, model: setup.agent.modelId })) process.exitCode = 1;
    const { runLifecycleHook } = await import("../core/hooks.js");
    await runLifecycleHook(
      setup.config.hooks,
      "session:end",
      { sessionId: setup.sessionId, messages: setup.agent.history.length },
      setup.cwd,
    );
    await stopMcpServers(setup.mcpConnections);
  }
}
