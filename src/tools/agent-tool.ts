import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ToolDef, ToolContext } from "./types.js";
import { truncateOutput } from "./types.js";
import { readTool, lsTool, writeTool, editTool } from "./fs-tools.js";
import { globTool, grepTool } from "./search-tools.js";
import { webFetchTool, webSearchTool } from "./web-tools.js";
import { bashTool } from "./bash.js";
import { Agent } from "../core/agent.js";
import { buildSubagentSystemPrompt, buildWorkerSystemPrompt } from "../core/system-prompt.js";
import { PermissionPolicy } from "../permissions/policy.js";
import type { OnPermission } from "../core/events.js";
import type { ShadowGit } from "../core/shadow-git.js";

const SUBAGENT_MAX_ITERATIONS = 15;
/** Workers implement, not just read — they get more room to edit and verify. */
const WORKER_MAX_ITERATIONS = 30;
/** Cumulative in+out tokens after which a runaway sub-agent is aborted. */
const SUBAGENT_TOKEN_BUDGET = 500_000;

/**
 * Read-only toolset for research sub-agents. No bash, no write/edit, and —
 * the recursion guard — no agent tool, so a sub-agent cannot spawn sub-agents.
 * Web tools are read-only too, so research sub-agents can consult the web.
 */
export function subagentTools(): ToolDef[] {
  return [readTool, lsTool, globTool, grepTool, webSearchTool, webFetchTool];
}

/**
 * Worker toolset: research plus write/edit/bash. Still no agent tool —
 * workers cannot spawn workers (Hermes-style spawn depth of one). Every
 * write/execute call goes through the PARENT's permission policy.
 */
export function workerTools(): ToolDef[] {
  return [...subagentTools(), writeTool, editTool, bashTool];
}

export interface AgentToolDeps {
  /** Live view of the parent's model so /model switches carry over. */
  getModel: () => { model: LanguageModel; modelId: string };
  /** Optional cheaper model override, from config.subagentModel. */
  getSubagentModel?: () => { model: LanguageModel; modelId: string };
  /** Named custom agents (.aerin/agents/*.md) selectable via input.agent. */
  namedAgents?: readonly import("../core/agents.js").NamedAgent[];
  /** Resolve a named agent's model override. */
  resolveModelFn?: (id: string) => LanguageModel;
  /** Parent's policy — workers inherit its rules, mode, and deny list. */
  policy?: PermissionPolicy;
  /** Parent's permission prompt — worker asks surface to the user through it. */
  onPermission?: OnPermission;
  /** Parent's shadow-git, so worker writes land in the parent turn's /undo snapshot. */
  getShadow?: () => Promise<ShadowGit | null>;
  /** Post-edit diagnostics command — workers self-correct the same way the parent does. */
  diagnosticsCmd?: string;
}

interface AgentToolInput {
  description: string;
  prompt: string;
  agent?: string;
  mode?: string;
}

let subagentCounter = 0;

export function createAgentTool(deps: AgentToolDeps): ToolDef<z.ZodTypeAny> {
  // Parallel workers must not open two permission dialogs at once — the TUI
  // holds a single pending request. Chain worker asks through one lock.
  let permissionLock: Promise<unknown> = Promise.resolve();
  const askSerialized: OnPermission = (req) => {
    const ask = deps.onPermission;
    if (!ask) return Promise.resolve({ kind: "deny", reason: "No interactive user to grant permissions." });
    const run = permissionLock.then(() => ask(req));
    permissionLock = run.catch(() => {});
    return run;
  };

  return {
    name: "agent",
    description:
      "Delegate a task to a sub-agent with its own context window; it returns a single text report. " +
      "Default: a read-only researcher (read, ls, glob, grep, web) for broad or exploratory questions — " +
      "the raw file contents it reads never enter this conversation. " +
      'With mode:"worker" the sub-agent can also edit files and run commands (write, edit, bash), for ' +
      "self-contained implementation tasks. Workers see NONE of this conversation: put every needed fact " +
      "(paths, conventions, acceptance criteria) in the prompt. " +
      "Read files directly when you know exactly where to look; do small edits yourself.",
    inputSchema: z.object({
      description: z.string().describe("Short 3-6 word label for the task, shown to the user"),
      prompt: z
        .string()
        .describe(
          "The full task. The sub-agent sees nothing else — include every needed fact. " +
            "For workers: exact files to change, conventions to follow, how to verify, what to report.",
        ),
      agent: z
        .string()
        .optional()
        .describe("Named custom agent to use (listed in the system prompt); omit for the default researcher"),
      mode: z
        .string()
        .optional()
        .describe('"worker" for a write-capable sub-agent (edit/write/bash); omit for read-only research'),
    }),
    permission: "read",
    summarize: (input) => {
      const i = input as AgentToolInput;
      const worker = i.mode === "worker" ? "worker: " : "";
      return `Agent(${worker}${i.agent ? `${i.agent}: ` : ""}${i.description})`;
    },
    async execute(rawInput, ctx: ToolContext): Promise<string> {
      const input = rawInput as AgentToolInput;
      const named = input.agent ? deps.namedAgents?.find((a) => a.name === input.agent) : undefined;
      if (input.agent && !named) {
        const known = deps.namedAgents?.map((a) => a.name).join(", ") || "none";
        throw new Error(`Unknown named agent: ${input.agent}. Available: ${known}`);
      }
      let { model, modelId } = deps.getSubagentModel?.() ?? deps.getModel();
      if (named?.model && deps.resolveModelFn) {
        model = deps.resolveModelFn(named.model);
        modelId = named.model;
      }
      const id = ctx.toolCallId ?? `subagent-${++subagentCounter}`;
      const isWorker = input.mode === "worker" || named?.mode === "worker";
      const basePrompt = isWorker ? buildWorkerSystemPrompt(ctx.cwd) : buildSubagentSystemPrompt(ctx.cwd);

      const sub = new Agent({
        model,
        modelId,
        // A named agent's own prompt leads; the standard sub-agent rules
        // (toolset, report contract) always apply underneath.
        systemPrompt: named ? `${named.systemPrompt}\n\n${basePrompt}` : basePrompt,
        tools: isWorker ? workerTools() : subagentTools(),
        // Workers inherit the parent's live policy: its allow/deny rules,
        // session approvals, and current mode all apply to worker actions.
        policy: isWorker && deps.policy ? deps.policy : new PermissionPolicy([], false),
        // Worker asks reach the real user (serialized — one dialog at a time,
        // labeled with the task); research sub-agents never ask by invariant,
        // and deny rather than hang if that invariant is ever broken.
        onPermission: isWorker
          ? (req) => askSerialized({ ...req, summary: `Agent(${input.description}) › ${req.summary}` })
          : async () => ({ kind: "deny", reason: "Sub-agents cannot request permissions." }),
        cwd: ctx.cwd,
        allowOutsideCwd: ctx.allowOutsideCwd,
        maxIterations: isWorker ? WORKER_MAX_ITERATIONS : SUBAGENT_MAX_ITERATIONS,
        // Worker writes must land in the parent turn's shadow snapshot so
        // /undo covers them; a second ShadowGit on the same index would race.
        ...(isWorker && deps.getShadow ? { getShadow: deps.getShadow } : {}),
        ...(isWorker && deps.diagnosticsCmd ? { diagnosticsCmd: deps.diagnosticsCmd } : {}),
      });

      const onAbort = (): void => sub.abort();
      ctx.abortSignal?.addEventListener("abort", onAbort);

      let toolCalls = 0;
      let lastTool: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd: number | undefined;
      let errorMsg: string | undefined;
      let budgetExceeded = false;
      let textBuf = "";
      let finalText = "";

      const progress = (status: "running" | "done" | "error"): void => {
        ctx.onProgress?.({
          type: "subagent-update",
          id,
          description: input.description,
          status,
          ...(lastTool !== undefined ? { lastTool } : {}),
          toolCalls,
          inputTokens,
          outputTokens,
          costUsd,
        });
      };

      try {
        for await (const event of sub.send(input.prompt)) {
          switch (event.type) {
            case "text-delta":
              textBuf += event.text;
              break;
            case "message-end":
              // The last completed assistant message is the report;
              // intermediate narration is discarded.
              finalText = textBuf;
              textBuf = "";
              break;
            case "tool-call":
              toolCalls++;
              lastTool = event.summary;
              progress("running");
              break;
            case "usage":
              inputTokens += event.inputTokens;
              outputTokens += event.outputTokens;
              if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
              progress("running");
              if (inputTokens + outputTokens > SUBAGENT_TOKEN_BUDGET && !budgetExceeded) {
                budgetExceeded = true;
                sub.abort(); // keep whatever report text exists
              }
              break;
            case "error":
              errorMsg = event.message;
              break;
            default:
              break;
          }
        }
      } finally {
        ctx.abortSignal?.removeEventListener("abort", onAbort);
      }
      // A partial stream that never reached message-end still counts as a report.
      if (!finalText && textBuf.trim()) finalText = textBuf;

      if (ctx.abortSignal?.aborted) {
        progress("error");
        throw new Error("Interrupted.");
      }
      if (errorMsg && !finalText) {
        progress("error");
        throw new Error(
          budgetExceeded ? "Sub-agent exceeded its token budget before producing a report." : `Sub-agent failed: ${errorMsg}`,
        );
      }
      progress("done");
      return truncateOutput(finalText || "(sub-agent produced no report)");
    },
  };
}
