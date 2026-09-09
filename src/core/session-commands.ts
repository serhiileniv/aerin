import type { Agent } from "./agent.js";
import type { PermissionMode, PermissionPolicy } from "../permissions/policy.js";
import type { Skill } from "./skills.js";
import type { CustomCommand } from "./commands.js";
import { SessionStore } from "../session/store.js";
import { persistProviderKey, type AerinConfig } from "../config/config.js";
import { keyLooksLike } from "../providers/catalog.js";
import { listProviderModels } from "../providers/list-models.js";
import { loopCommand as runLoop } from "./loop.js";
import type { ModelMessage } from "ai";

/**
 * Frontend-independent slash-command implementations. The TUI and REPL both
 * render what these return — one implementation per command, so the two
 * frontends can never drift again (they demonstrably did while duplicated).
 * Interactive flows (pickers, dialogs) remain frontend concerns.
 */

export interface CommandCtx {
  agent: Agent;
  policy: PermissionPolicy;
  skills: readonly Skill[];
  mcpConnections: readonly { serverName: string; tools: { name: string }[] }[];
  customCommands: readonly CustomCommand[];
  sessionId: string;
  cwd: string;
}

export const SLASH_COMMANDS = [
  { name: "/model", description: "switch model — pick from a live list, or /model provider/id" },
  { name: "/plan", description: "toggle plan mode — read-only exploration, agent presents a plan" },
  { name: "/undo", description: "revert the file changes of the last turn (incl. bash side effects)" },
  { name: "/redo", description: "re-apply changes reverted by /undo" },
  { name: "/connect", description: "connect a provider — catalog, custom OpenAI- or Anthropic-compatible endpoints" },
  { name: "/compact", description: "summarize the conversation to free context" },
  { name: "/clear", description: "clear conversation history" },
  { name: "/resume", description: "resume a previous conversation in this directory" },
  { name: "/status", description: "session overview — model, mode, tokens, servers, jobs" },
  { name: "/goal", description: "autonomous goal loop — /goal <text> works until a judge sees it done; /goal clear stops" },
  { name: "/loop", description: "run a prompt on a schedule via every — /loop 15m <prompt>; /loop lists, /loop log|run|stop <name>" },
  { name: "/skills", description: "list available skill packs" },
  { name: "/mcp", description: "list connected MCP servers and their tools" },
  { name: "/help", description: "show commands and keys" },
  { name: "/exit", description: "quit aerin" },
] as const;

/** `/help` body shared by both frontends: built-ins plus this project's custom commands. */
export function helpLines(ctx: Pick<CommandCtx, "customCommands">, extra: { name: string; description: string }[] = []): string[] {
  const cmds = [...SLASH_COMMANDS, ...extra, ...ctx.customCommands.map((c) => ({ name: `/${c.name}`, description: `(custom) ${c.description}` }))];
  const pad = Math.max(...cmds.map((c) => c.name.length)) + 3;
  return cmds.map((c) => `  ${c.name.padEnd(pad)}${c.description}`);
}

/**
 * Save a provider key and validate it RIGHT NOW — a wrong key must be loud,
 * not a mystery later. Messages go through `emit`; returns true when the key works.
 */
export async function connectCommand(
  ctx: { config: AerinConfig },
  id: string,
  key: string,
  baseURL: string | undefined,
  protocol: "openai" | "anthropic" | undefined,
  emit: (kind: "info" | "error", text: string) => void,
): Promise<boolean> {
  const looks = key ? keyLooksLike(key) : undefined;
  if (looks && looks !== id) {
    emit("error", `✗ that looks like a ${looks} key (${key.slice(0, 7)}…), not a ${id} key — nothing saved. Run /connect ${looks} instead.`);
    return false;
  }
  try {
    await persistProviderKey(id, key, baseURL, protocol);
    ctx.config.providers = {
      ...ctx.config.providers,
      [id]: { ...ctx.config.providers?.[id], ...(key ? { apiKey: key } : {}), ...(baseURL ? { baseURL } : {}), ...(protocol ? { protocol } : {}) },
    };
  } catch (err) {
    emit("error", err instanceof Error ? err.message : String(err));
    return false;
  }
  emit("info", `(checking the ${id} key…)`);
  try {
    const models = await listProviderModels(id, ctx.config);
    if (!models || models.length === 0) {
      emit("error", `✗ ${id}: the key was saved but the provider returned no models — it may be the wrong provider's key. Re-run /connect ${id} with the right one.`);
      return false;
    }
    emit("info", `✓ ${id} key works — ${models.length} models available`);
    return true;
  } catch (err) {
    emit("error", `✗ ${id} REJECTED the key (${err instanceof Error ? err.message : err}). Did you paste a different provider's key? The key is saved but unusable — re-run /connect ${id}.`);
    return false;
  }
}

export interface GoalResult {
  message: string;
  /** Prompt the frontend should submit to start the autonomous goal loop. */
  run?: string;
}

export function goalCommand(ctx: CommandCtx, arg: string): GoalResult {
  if (arg === "clear" || arg === "off") {
    ctx.agent.setGoal(undefined);
    return { message: "(goal cleared — autonomous loop stopped)" };
  }
  if (arg) {
    // Arms the loop: after each finished turn a judge checks the goal and the
    // agent keeps working until done or the turn budget runs out.
    ctx.agent.startGoal(arg);
    return { message: `goal armed — working autonomously until the judge sees it done: ${arg}`, run: arg };
  }
  return {
    message: ctx.agent.currentGoal
      ? `current goal: ${ctx.agent.currentGoal}`
      : "(no goal set — /goal <text> starts an autonomous goal loop; /goal clear stops it)",
  };
}

/**
 * `/loop <when> <prompt>`: schedule a headless aerin run through `every`
 * (see docs/scheduling.md). Lives outside the session, so it keeps firing
 * after aerin exits; `/loop` alone lists, `/loop log|run|stop <name>` manage.
 */
export function loopCommand(ctx: CommandCtx, arg: string): Promise<string> {
  return runLoop({ cwd: ctx.cwd, yolo: ctx.policy.autoApprove, modelId: ctx.agent.modelId }, arg);
}

export function skillsCommand(ctx: CommandCtx): string {
  if (ctx.skills.length === 0) {
    return "No skills found. Add one at .aerin/skills/<name>/SKILL.md (existing .claude/skills are read too).";
  }
  const pad = Math.max(...ctx.skills.map((s) => s.name.length)) + 2;
  return `Skills:\n${ctx.skills.map((s) => `  ${s.name.padEnd(pad)}${s.description}`).join("\n")}\nThe agent loads one with the skill tool when a task matches.`;
}

export function mcpCommand(ctx: CommandCtx): string {
  if (ctx.mcpConnections.length === 0) {
    return 'No MCP servers connected. Add them under "mcpServers" in the config (stdio or HTTP).';
  }
  return `MCP servers:\n${ctx.mcpConnections
    .map((c) => {
      const names = c.tools.map((t) => t.name.replace(`mcp__${c.serverName}__`, ""));
      return `  ${c.serverName} — ${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`;
    })
    .join("\n")}`;
}

export async function undoCommand(ctx: CommandCtx): Promise<string> {
  const restored = await ctx.agent.undo();
  if (restored.length === 0) return "(nothing to undo — no file changes recorded this session)";
  const rel = restored.map((p) => (p.startsWith(ctx.cwd) ? p.slice(ctx.cwd.length + 1) : p));
  return `(reverted ${restored.length} file${restored.length === 1 ? "" : "s"}: ${rel.join(", ").slice(0, 120)} — /redo re-applies)`;
}

export async function redoCommand(ctx: CommandCtx): Promise<string> {
  const restored = await ctx.agent.redo();
  if (restored.length === 0) return "(nothing to redo — /redo only re-applies changes reverted by /undo)";
  const rel = restored.map((p) => (p.startsWith(ctx.cwd) ? p.slice(ctx.cwd.length + 1) : p));
  return `(re-applied ${restored.length} file${restored.length === 1 ? "" : "s"}: ${rel.join(", ").slice(0, 120)})`;
}

export function togglePlan(ctx: CommandCtx): PermissionMode {
  const next: PermissionMode = ctx.policy.inPlanMode ? "manual" : "plan";
  ctx.policy.setMode(next);
  return next;
}

export function cycleMode(ctx: CommandCtx): PermissionMode {
  const current = ctx.policy.currentMode;
  const next: PermissionMode = current === "manual" ? "accept" : current === "accept" ? "plan" : "manual";
  ctx.policy.setMode(next);
  return next;
}

export interface CompactResult {
  message: string;
  contextTokens: number;
}

export async function compactCommand(ctx: CommandCtx): Promise<CompactResult> {
  const before = ctx.agent.history.length;
  if (before === 0) {
    return { message: "(nothing to compact — history is empty)", contextTokens: 0 };
  }
  await ctx.agent.compactNow();
  const after = ctx.agent.history.length;
  const est = ctx.agent.estimateContextTokens();
  return {
    message:
      after === before
        ? "(history is still small — nothing was summarized)"
        : `(compacted ${before} → ${after} messages, ~${est} tokens of context)`,
    contextTokens: est,
  };
}

/** Open a saved session and swap it into the live agent. Returns its messages for replay. */
export async function resumeById(ctx: CommandCtx, id: string): Promise<readonly ModelMessage[]> {
  const { store, messages } = await SessionStore.open(ctx.cwd, id);
  ctx.agent.loadSession(store, messages);
  return messages;
}

export interface StatusExtras {
  modelId: string;
  contextWindow?: number;
  ctxTokens?: number;
  costLine?: string;
  latestVersion?: string;
  version: string;
  jobsLine?: string;
  cwdDisplay?: string;
}

export function statusCommand(ctx: CommandCtx, x: StatusExtras): string {
  const pct =
    x.ctxTokens && x.contextWindow ? ` (${Math.round((x.ctxTokens / x.contextWindow) * 100)}% of context used)` : "";
  const mode = ctx.policy.currentMode === "accept" ? "accept edits" : ctx.policy.currentMode;
  return [
    `aerin v${x.version}${x.latestVersion && x.latestVersion !== x.version ? ` · v${x.latestVersion} available · aerin update` : ""}`,
    `  session   ${ctx.sessionId} · ${ctx.agent.history.length} messages`,
    `  model     ${x.modelId}${pct}`,
    `  mode      ${mode}${ctx.agent.currentGoal ? ` · goal: ${ctx.agent.currentGoal.slice(0, 50)}` : ""}`,
    `  cwd       ${x.cwdDisplay ?? ctx.cwd}`,
    ...(x.costLine ? [`  tokens    ${x.costLine}`] : []),
    `  mcp       ${ctx.mcpConnections.length > 0 ? ctx.mcpConnections.map((c) => c.serverName).join(", ") : "none"}`,
    `  skills    ${ctx.skills.length > 0 ? ctx.skills.map((s) => s.name).join(", ") : "none"}`,
    `  commands  ${ctx.customCommands.length > 0 ? ctx.customCommands.map((c) => "/" + c.name).join(", ") : "none"}`,
    ...(x.jobsLine ? [`  jobs      ${x.jobsLine}`] : []),
  ].join("\n");
}
