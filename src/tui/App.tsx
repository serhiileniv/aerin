import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { LanguageModel, ModelMessage } from "ai";
import type { Agent } from "../core/agent.js";
import type { OnPermission, PermissionDecision, PermissionRequest } from "../core/events.js";
import { persistModelChoice, persistProviderKey, type AerinConfig } from "../config/config.js";
import { renderCommand, type CustomCommand } from "../core/commands.js";
import { listJobs } from "../tools/bash-jobs.js";
import {
  compactCommand,
  cycleMode,
  goalCommand,
  mcpCommand,
  resumeById,
  skillsCommand,
  statusCommand,
  togglePlan,
  undoCommand,
  redoCommand,
} from "../core/session-commands.js";
import { allKnownModels, modelInfo } from "../providers/models.js";
import { PROVIDERS, providersWithKeys, resolveApiKey } from "../providers/registry.js";
import { PROVIDER_CATALOG, catalogEntry, keyLooksLike } from "../providers/catalog.js";
import { discoverModels, formatModelLabel, isSmallModel, listProviderModels, type DiscoveredModel } from "../providers/list-models.js";
import { modelsDevProviders } from "../providers/modelsdev.js";
import { VERSION } from "../version.js";
import { SessionStore, type SessionSummary } from "../session/store.js";
import type { AskUser } from "../tools/question-tool.js";
import type { TodoItem } from "../tools/todo-tool.js";
import type { PermissionMode, PermissionPolicy } from "../permissions/policy.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { anchorOffset, buildFlatLines, prefixUserLines, scrollWindow, stepScroll, type TranscriptKind } from "./scroll.js";
import { colorizeDiff, messageText, redactSecrets, relativeTime, setTerminalTitle } from "../terminal/format.js";
import { expandMentions } from "../core/mentions.js";
import { DiffText, FilterSelect, LineInput, SelectList, Spinner } from "./components/widgets.js";
import { C, isLightTheme } from "./theme.js";

/** Everything the TUI needs, assembled by run.tsx. */
export interface TuiSetup {
  agent: Agent;
  modelId: string;
  cwd: string;
  warnings: string[];
  /** Swappable so the dialogs can be wired after agent construction. */
  onPermissionRef: { current: OnPermission };
  onQuestionRef: { current: AskUser };
  policy: PermissionPolicy;
  customCommands: CustomCommand[];
  skills: import("../core/skills.js").Skill[];
  mcpConnections: import("../mcp/manager.js").McpConnection[];
  sessionId: string;
  resolveModelFn: (id: string) => LanguageModel;
  config: AerinConfig;
  /** Set when startup could not resolve a model; forces the picker open first. */
  modelUnavailable?: string;
  /** Emits "wheel" (+1 down / -1 up) from the terminal mouse — set by run.tsx. */
  mouse?: import("node:events").EventEmitter;
}

/**
 * Ink rendering rules baked in here:
 * - Full-screen app on the alternate screen buffer (opencode-style): a fixed
 *   height/width root, a flex-grown transcript viewport with overflow hidden
 *   + justifyContent flex-end (newest content sticks to the bottom, old lines
 *   clip at the top), and a bottom section (dialogs, input, status) whose
 *   height the layout engine subtracts automatically. The app owns the whole
 *   window — there is no terminal scrollback above it; scrolling is in-app
 *   (wheel / PgUp/PgDn) over a pre-wrapped visual-line buffer that includes
 *   the LIVE streaming text, so output never freezes while scrolled back.
 * - Only the last VIEWPORT_ITEMS transcript items render live (older ones are
 *   clipped anyway); that bounds per-frame work.
 * - Stream re-renders are batched to ~50ms, never per-token setState.
 * - Raw mode eats Ctrl+C, so double-Ctrl+C-to-exit is implemented explicitly.
 */

interface TranscriptItem {
  key: number;
  kind: TranscriptKind;
  text: string;
  /** Raw markdown for "assistant" items — kept so a resize can re-wrap at the new width instead of leaving stale hard-wraps. */
  raw?: string;
}

/** Only this many trailing items are rendered live — everything above is clipped anyway. */
const VIEWPORT_ITEMS = 150;

/**
 * Picker rows: Recent (opencode-style), then Recommended — up to 2 small/
 * fast/tool-capable models per connected provider (isSmallModel heuristic),
 * so a fresh /model doesn't dump every model from every provider before you
 * can find a quick default — then the full list, one group per provider.
 */
function buildPickerItems(
  models: DiscoveredModel[],
  recent: readonly string[],
  currentId: string,
): { label: string; value: string; header?: boolean }[] {
  const items: { label: string; value: string; header?: boolean }[] = [];
  const mark = (id: string): string => (id === currentId ? "  ✓ current" : "");

  const recentShown = recent.filter((id) => id === currentId || models.some((m) => m.id === id));
  if (recentShown.length > 0) {
    items.push({ label: "Recent", value: "__header_recent", header: true });
    for (const id of recentShown) {
      const m = models.find((mm) => mm.id === id);
      items.push({ label: (m ? formatModelLabel(m) : id) + mark(id), value: id });
    }
  }
  const inRecent = new Set(recentShown);

  const recommendedByProvider = new Map<string, DiscoveredModel[]>();
  for (const m of models) {
    if (inRecent.has(m.id) || !isSmallModel(m.id)) continue;
    const list = recommendedByProvider.get(m.provider) ?? [];
    if (list.length < 2) {
      list.push(m);
      recommendedByProvider.set(m.provider, list);
    }
  }
  const recommended = [...recommendedByProvider.values()].flat();
  if (recommended.length > 0) {
    items.push({ label: "Recommended — small, fast, tool-capable", value: "__header_recommended", header: true });
    for (const m of recommended) items.push({ label: formatModelLabel(m) + mark(m.id), value: m.id });
  }
  const inRecommended = new Set(recommended.map((m) => m.id));

  let lastProvider = "";
  for (const m of models) {
    if (inRecent.has(m.id) || inRecommended.has(m.id)) continue; // already shown above
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      items.push({
        label: PROVIDERS[m.provider]?.name ?? catalogEntry(m.provider)?.name ?? m.provider,
        value: `__header_${m.provider}`,
        header: true,
      });
    }
    items.push({ label: formatModelLabel(m, { stripProvider: true }) + mark(m.id), value: m.id });
  }
  return items;
}

type ConnectProtocol = "openai" | "anthropic";

type ConnectState =
  | { step: "pick"; dynamic: import("../providers/modelsdev.js").ModelsDevProvider[] }
  | { step: "key"; id: string; label: string; baseURL?: string; protocol?: ConnectProtocol }
  | { step: "custom-name" }
  | { step: "custom-protocol"; id: string }
  | { step: "custom-url"; id: string; protocol: ConnectProtocol }
  | { step: "custom-key"; id: string; baseURL: string; protocol: ConnectProtocol };

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
}

const SLASH_COMMANDS = [
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
  { name: "/skills", description: "list available skill packs" },
  { name: "/mcp", description: "list connected MCP servers and their tools" },
  { name: "/help", description: "show commands and keys" },
  { name: "/exit", description: "quit aerin" },
] as const;

/** ANSI Shadow wordmark shown in the startup banner (37 cols × 6 rows). */
const LOGO = [
  " █████╗ ███████╗██████╗ ██╗███╗   ██╗",
  "██╔══██╗██╔════╝██╔══██╗██║████╗  ██║",
  "███████║█████╗  ██████╔╝██║██╔██╗ ██║",
  "██╔══██║██╔══╝  ██╔══██╗██║██║╚██╗██║",
  "██║  ██║███████╗██║  ██║██║██║ ╚████║",
  "╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝",
] as const;
const MIN_LOGO_COLUMNS = 42;
/** Row shades for the wordmark: Emerald at the top, through Dark Jade, into
 * traditional pigment Emerald Green at the bottom — three real named colors. */
const SUNSET = ["#50c878", "#30a96a", "#108a5b", "#017545", "#026c26", "#046307"] as const;

/** Truecolor ANSI paint for banner text baked into the transcript. */
function paint(s: string, hex: string, bold = false): string {
  const n = parseInt(hex.slice(1), 16);
  return `${bold ? "\x1b[1m" : ""}\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m`;
}

/** "● " on the first line, aligned indent on the rest — Claude Code-style blocks. */
function withDot(text: string): string {
  const lines = text.split("\n");
  return [paint("●", C.accentBright) + " " + (lines[0] ?? ""), ...lines.slice(1).map((l) => "  " + l)].join("\n");
}

/** One-line result stat for the result line: short outputs verbatim, long ones as a count. */
function resultStat(output: string, isError: boolean): string {
  const trimmed = output.trim();
  if (!trimmed) return "(no output)";
  const lines = trimmed.split("\n");
  const first = (lines[0] ?? "").slice(0, 120);
  if (isError) return first;
  if (lines.length === 1 && first.length <= 100) return first;
  return `${lines.length} lines`;
}

/** "~" for home, middle-ellipsis for long paths — keeps the header tidy. */
function shortenPath(p: string, max = 45): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  let out = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (out.length > max) out = out.slice(0, Math.floor(max / 2) - 1) + "…" + out.slice(-Math.floor(max / 2));
  return out;
}

/** "42s" / "3m 12s" for turn durations. */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1e3).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function App(props: { setup: TuiSetup; initialPrompt?: string }): React.ReactElement {
  const { setup } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Terminal geometry — the root Box is sized to it and Yoga does the rest.
  const [size, setSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  useEffect(() => {
    const onResize = (): void => setSize({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);
  // One row short of the terminal: at full height Ink switches to a
  // clear-terminal-per-frame fullscreen path, which visibly flickers on every
  // keystroke. One spare row keeps it on the incremental line-diff path.
  const usableRows = Math.max(10, size.rows - 1);

  // The startup banner is transcript content, not chrome (Claude Code-style):
  // it scrolls away as the conversation grows and reappears on /clear.
  // Jade fade: the wordmark fades row by row from Emerald through Dark
  // Jade into deep pigment Emerald Green at a horizon line — all aerin.
  const bannerItem = (model: string, key = 0): TranscriptItem => {
    const art =
      size.columns >= MIN_LOGO_COLUMNS
        ? LOGO.map((row, i) =>
            paint(row, isLightTheme() ? C.accentBright : (SUNSET[i] ?? C.accentBright), true),
          ).join("\n")
        : paint("✦ Aerin", C.accentBright, true);
    const horizon = paint("─".repeat(Math.min(37, Math.max(10, size.columns - 4))), C.magenta);
    const info =
      paint(`v${VERSION} · `, C.dim) + paint(model, C.accent) + paint(` · ${shortenPath(setup.cwd)}`, C.dim);
    return { key, kind: "assistant", text: `${art}\n${horizon}\n${info}` };
  };
  const [items, setItems] = useState<TranscriptItem[]>(() => [
    bannerItem(setup.modelId),
    ...setup.warnings.map((w, i) => ({ key: i + 1, kind: "error" as const, text: `warning: ${w}` })),
  ]);
  const [streaming, setStreaming] = useState("");
  const [working, setWorking] = useState(false);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [denyReasonMode, setDenyReasonMode] = useState(false);
  const [modelPicker, setModelPicker] = useState<"loading" | DiscoveredModel[] | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionSummary[] | null>(null);
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [question, setQuestion] = useState<{
    q: string;
    options: string[];
    resolve: (answer: string) => void;
  } | null>(null);
  const [questionOther, setQuestionOther] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("manual");
  const planMode = mode === "plan";
  const [goalSet, setGoalSet] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | undefined>(undefined);
  const [exitArmed, setExitArmed] = useState(false);
  const [stats, setStats] = useState({ inTok: 0, outTok: 0, cost: 0 });
  const [modelId, setModelId] = useState(setup.modelId);
  const [recentModels, setRecentModels] = useState<string[]>(setup.config.recentModels ?? []);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0); // lines scrolled back from the live bottom
  const [queued, setQueued] = useState<string[]>([]); // messages typed while the agent was working
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [thinking, setThinking] = useState(false);
  const [reasoningTail, setReasoningTail] = useState("");
  const [ctxTokens, setCtxTokens] = useState(0);
  const [subagents, setSubagents] = useState<
    Map<string, { description: string; lastTool?: string; toolCalls: number }>
  >(new Map());
  const reasoningBuf = useRef("");
  const reasoningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nextKey = useRef(100);
  const streamBuf = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workingRef = useRef(false);
  const turnStartRef = useRef(0);
  const lastToolResultRef = useRef<{ summary: string; output: string; isError: boolean } | null>(null);
  const lastSummaryRef = useRef<string | null>(null);

  const pushItem = useCallback((kind: TranscriptItem["kind"], text: string) => {
    if (kind === "user") setScrollOffset(0); // your own message — jump back to live
    setItems((prev) => [...prev, { key: nextKey.current++, kind, text }]);
  }, []);

  // Workspace file list for @-mention completion; best effort, loaded once.
  useEffect(() => {
    void (async () => {
      try {
        const fg = (await import("fast-glob")).default;
        const files = await fg(["**/*"], {
          cwd: setup.cwd,
          onlyFiles: true,
          dot: false,
          followSymbolicLinks: false,
          suppressErrors: true,
          deep: 8,
          ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"],
        });
        setWorkspaceFiles(files.slice(0, 5000).sort());
      } catch {
        // no completion — @mentions still expand on submit
      }
    })();
  }, [setup.cwd]);

  // Startup update check; silent unless a newer version exists.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("https://registry.npmjs.org/aerin-agent/latest", {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        const latest = ((await res.json()) as { version?: string }).version;
        if (latest) setLatestVersion(latest);
        if (latest && latest !== VERSION && VERSION !== "0.0.0") {
          pushItem("info", `(update available: v${latest} — run "aerin update")`);
        }
      } catch {
        // offline — never bother the user
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire the agent's permission and question callbacks to the dialogs. Both
  // block the agent on you specifically — worth a bell if you're elsewhere.
  useEffect(() => {
    setup.onPermissionRef.current = (req) => {
      process.stdout.write("\x07");
      return new Promise<PermissionDecision>((resolve) => setPermission({ req, resolve }));
    };
    setup.onQuestionRef.current = (q, options) => {
      process.stdout.write("\x07");
      return new Promise<string>((resolve) => setQuestion({ q, options, resolve }));
    };
  }, [setup]);

  // Markdown reflow width: full window minus the ● indent and border slack.
  const mdWidth = useCallback(() => Math.max(40, (stdout?.columns ?? 80) - 4), [stdout]);

  // Assistant text keeps its raw markdown so a later resize can re-wrap it —
  // renderMarkdown bakes hard-wraps at the CURRENT width, which turns into
  // ragged, double-wrapped text if the terminal is resized afterward.
  const pushAssistant = useCallback(
    (raw: string) => {
      setItems((prev) => [
        ...prev,
        { key: nextKey.current++, kind: "assistant", text: withDot(renderMarkdown(raw, mdWidth())), raw },
      ]);
    },
    [mdWidth],
  );

  // Re-wrap every cached assistant reply when the terminal width changes —
  // otherwise old replies stay hard-wrapped at whatever width they were
  // first rendered at, producing ragged double-wrapped text.
  useEffect(() => {
    setItems((prev) =>
      prev.map((it) => (it.kind === "assistant" && it.raw ? { ...it, text: withDot(renderMarkdown(it.raw, mdWidth())) } : it)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.columns]);

  const flushStream = useCallback(() => {
    flushTimer.current = null;
    // Render markdown live while streaming — partial constructs (an unclosed
    // code fence, a half-typed **bold) degrade gracefully in marked-terminal.
    // The ▌ cursor marks where new text lands.
    setStreaming(withDot(renderMarkdown(streamBuf.current, mdWidth())) + paint("▌", C.accentBright));
  }, []);

  const runTurn = useCallback(
    async (prompt: string, display?: string) => {
      workingRef.current = true;
      turnStartRef.current = Date.now();
      setWorking(true);
      setTerminalTitle("aerin");
      pushItem("user", redactSecrets(display ?? prompt));
      // @path tokens attach text files to the prompt and images as multimodal
      // parts (display stays clean).
      const expanded = await expandMentions(prompt, setup.cwd).catch(() => ({ text: prompt, images: [] }));
      if (expanded.images.length > 0) {
        pushItem("info", `  └ attached ${expanded.images.map((i) => i.name).join(", ")}`);
      }
      try {
        for await (const event of setup.agent.send(expanded.text, expanded.images)) {
          switch (event.type) {
            case "reasoning-delta": {
              setThinking(true);
              reasoningBuf.current += event.text;
              if (!reasoningTimer.current) {
                reasoningTimer.current = setTimeout(() => {
                  reasoningTimer.current = null;
                  // Show only the tail — enough to follow along without flooding.
                  const lines = reasoningBuf.current.split("\n").filter((l) => l.trim());
                  setReasoningTail(lines.slice(-3).join("\n"));
                }, 80);
              }
              break;
            }
            case "text-delta": {
              setThinking(false);
              reasoningBuf.current = "";
              setReasoningTail("");
              streamBuf.current += event.text;
              if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 50);
              break;
            }
            case "message-end": {
              if (flushTimer.current) clearTimeout(flushTimer.current);
              flushTimer.current = null;
              const text = streamBuf.current;
              streamBuf.current = "";
              setStreaming("");
              if (text.trim()) pushAssistant(text);
              break;
            }
            case "tool-call":
              pushItem("tool", `● ${event.summary}`);
              lastSummaryRef.current = event.summary;
              break;
            case "tool-result": {
              const stat = resultStat(event.output, event.isError);
              const collapsed = stat !== event.output.trim();
              lastToolResultRef.current = {
                summary: lastSummaryRef.current ?? event.name,
                output: event.output,
                isError: event.isError,
              };
              pushItem(
                event.isError ? "tool-error" : "info",
                `  └ ${event.isError ? "✗ " : ""}${stat}${collapsed ? " (ctrl+o expand)" : ""}`,
              );
              break;
            }
            case "compaction":
              pushItem("info", `[compacting context — was ${event.preTokens} tokens]`);
              break;
            case "todo-update":
              setTodos(event.items);
              break;
            case "tool-display":
              pushItem("info", colorizeDiff(event.text));
              break;
            case "retry":
              pushItem(
                "info",
                `(provider error — retrying, attempt ${event.attempt}/${event.maxAttempts}: ${event.message.slice(0, 80)})`,
              );
              break;
            case "failover":
              pushItem(
                "info",
                `(${event.from} failed: ${event.message.slice(0, 80)} — continuing on ${event.to})`,
              );
              break;
            case "goal-check":
              pushItem(
                "info",
                event.done
                  ? `✓ goal complete — ${event.reason}`
                  : `↻ goal continues (${event.turnsLeft} turns left) — ${event.reason}`,
              );
              if (event.done) setGoalSet(false);
              break;
            case "subagent-update": {
              if (event.status === "running") {
                setSubagents((m) =>
                  new Map(m).set(event.id, {
                    description: event.description,
                    ...(event.lastTool !== undefined ? { lastTool: event.lastTool } : {}),
                    toolCalls: event.toolCalls,
                  }),
                );
              } else {
                setSubagents((m) => {
                  const next = new Map(m);
                  next.delete(event.id);
                  return next;
                });
                const tok = fmtTokens(event.inputTokens + event.outputTokens);
                pushItem(
                  event.status === "error" ? "tool-error" : "info",
                  `  └ agent ${event.status}: ${event.description} (${event.toolCalls} tools, ${tok} tok${event.costUsd ? `, ~$${event.costUsd.toFixed(4)}` : ""})`,
                );
                // Sub-agent spend is folded into the agent totals by the core loop.
                setStats({
                  inTok: setup.agent.totalInputTokens,
                  outTok: setup.agent.totalOutputTokens,
                  cost: setup.agent.totalCostUsd,
                });
              }
              break;
            }
            case "usage":
              setCtxTokens(event.inputTokens); // context size of the latest request
              setStats({
                inTok: setup.agent.totalInputTokens,
                outTok: setup.agent.totalOutputTokens,
                cost: setup.agent.totalCostUsd,
              });
              break;
            case "error":
              pushItem("error", event.message);
              break;
            default:
              break;
          }
        }
      } finally {
        workingRef.current = false;
        setWorking(false);
        setThinking(false);
        setReasoningTail("");
        reasoningBuf.current = "";
        // An aborted/errored turn never reaches message-end — flush what
        // streamed so it is not lost, and never leaks into the next turn.
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = null;
        if (reasoningTimer.current) clearTimeout(reasoningTimer.current);
        reasoningTimer.current = null;
        if (streamBuf.current.trim()) pushAssistant(streamBuf.current);
        streamBuf.current = "";
        setStreaming("");
        // Tell the user what the wait cost them — but skip trivial turns.
        // The terminal bell matters most here: a turn worth announcing is
        // also one worth noticing from another window/tab.
        const elapsed = Date.now() - turnStartRef.current;
        if (elapsed >= 3000) {
          pushItem("info", `  └ done in ${fmtDuration(elapsed)}`);
          process.stdout.write("\x07");
        }
        settleDialogs();
        setSubagents(new Map()); // clear stragglers on abort/error
        setTerminalTitle("aerin");
      }
      // Drain the queue: a message starts a turn (whose finally drains the
      // next); a command runs inline and must keep draining itself.
      setQueued(function drainStep(q): string[] {
        const [next, ...rest] = q;
        if (next !== undefined) {
          setTimeout(() => {
            if (next.startsWith("/")) {
              runCommand(next);
              setQueued(drainStep); // commands don't start turns — keep going
            } else {
              void runTurn(next);
            }
          }, 0);
        }
        return rest;
      });
    },
    [setup, pushItem, pushAssistant, flushStream],
  );

  // Re-render a saved conversation into the transcript, Claude Code-style:
  // user/assistant text plus one-liners for the tool calls between them.
  const replayHistory = useCallback((messages: readonly ModelMessage[]) => {
    const add: TranscriptItem[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const t = messageText(m);
        if (t.trim()) add.push({ key: nextKey.current++, kind: "user", text: t });
      } else if (m.role === "assistant") {
        if (Array.isArray(m.content)) {
          for (const part of m.content as { type?: string; text?: string; toolName?: string }[]) {
            if (part?.type === "text" && part.text?.trim()) {
              add.push({
                key: nextKey.current++,
                kind: "assistant",
                text: withDot(renderMarkdown(part.text, mdWidth())),
                raw: part.text,
              });
            } else if (part?.type === "tool-call" && part.toolName) {
              add.push({ key: nextKey.current++, kind: "tool", text: `● ${part.toolName}` });
            }
          }
        } else {
          const t = messageText(m);
          if (t.trim())
            add.push({ key: nextKey.current++, kind: "assistant", text: withDot(renderMarkdown(t, mdWidth())), raw: t });
        }
      }
    }
    setItems((prev) => [...prev, ...add]);
  }, []);

  const resumeSession = useCallback(
    async (id: string): Promise<void> => {
      const messages = await resumeById(setup, id);
      pushItem("info", `── resumed conversation (${messages.length} messages) ──`);
      replayHistory(messages);
      setCtxTokens(setup.agent.estimateContextTokens());
    },
    [setup, pushItem, replayHistory],
  );

  const openModelPicker = useCallback(async (): Promise<void> => {
    setModelPicker("loading");
    const { models, warnings } = await discoverModels(setup.config);
    for (const w of warnings) pushItem("error", w);
    if (models.length > 0) {
      setModelPicker(models);
    } else if (providersWithKeys(setup.config).length === 0) {
      // Nothing connected at all — the fix is a provider, not a model list.
      setModelPicker(null);
      pushItem("info", "(no providers connected yet — pick one to connect first)");
      void modelsDevProviders()
        .catch(() => [])
        .then((dynamic) => setConnect({ step: "pick", dynamic }));
    } else if (Object.keys(allKnownModels()).length > 0) {
      // Provider lists unreachable (offline?) — fall back to the models.dev
      // cache for the providers that have keys.
      const connected = new Set(providersWithKeys(setup.config));
      const cached = Object.entries(allKnownModels())
        .filter(([id]) => connected.has(id.split("/")[0] ?? ""))
        .map(([id, info]) => ({
          id,
          provider: id.split("/")[0] ?? "",
          contextWindow: info.contextWindow,
          ...(info.inputPerMTok !== undefined ? { inputPerMTok: info.inputPerMTok } : {}),
          ...(info.outputPerMTok !== undefined ? { outputPerMTok: info.outputPerMTok } : {}),
        }));
      if (cached.length > 0) {
        pushItem("info", "(provider lists unreachable — showing cached registry data)");
        setModelPicker(cached);
      } else {
        pushItem("error", "No model lists reachable. Type /model provider/model-id directly.");
        setModelPicker(null);
      }
    } else {
      pushItem("error", "No model lists reachable and no cached registry yet. Type /model provider/model-id directly.");
      setModelPicker(null);
    }
  }, [setup, pushItem]);

  const saveConnection = useCallback(
    async (id: string, key: string, baseURL?: string, protocol?: ConnectProtocol): Promise<void> => {
      // A key whose format belongs to another provider is refused outright.
      const looks = key ? keyLooksLike(key) : undefined;
      if (looks && looks !== id) {
        pushItem(
          "error",
          `✗ that looks like a ${looks} key (${key.slice(0, 7)}…), not a ${id} key — nothing saved. Run /connect ${looks} instead.`,
        );
        return;
      }
      try {
        await persistProviderKey(id, key, baseURL, protocol);
        setup.config.providers = {
          ...setup.config.providers,
          [id]: {
            ...setup.config.providers?.[id],
            ...(key ? { apiKey: key } : {}),
            ...(baseURL ? { baseURL } : {}),
            ...(protocol ? { protocol } : {}),
          },
        };
      } catch (err) {
        pushItem("error", err instanceof Error ? err.message : String(err));
        return;
      }
      // Validate the key RIGHT NOW — a wrong key must be loud, not a mystery later.
      pushItem("info", `(checking the ${id} key…)`);
      try {
        const models = await listProviderModels(id, setup.config);
        if (!models || models.length === 0) {
          pushItem(
            "error",
            `✗ ${id}: the key was saved but the provider returned no models — it may be the wrong provider's key. Re-run /connect ${id} with the right one.`,
          );
          return;
        }
        pushItem("info", `✓ ${id} key works — ${models.length} models available`);
        await openModelPicker();
      } catch (err) {
        pushItem(
          "error",
          `✗ ${id} REJECTED the key (${err instanceof Error ? err.message : err}). ` +
            `Did you paste a different provider's key? The key is saved but unusable — re-run /connect ${id}.`,
        );
      }
    },
    [setup, pushItem, openModelPicker],
  );

  const handleCommand = useCallback(
    async (line: string): Promise<void> => {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "/help": {
          const cmds = [
            ...SLASH_COMMANDS,
            ...setup.customCommands.map((c) => ({ name: `/${c.name}`, description: `(custom) ${c.description}` })),
          ];
          const pad = Math.max(...cmds.map((c) => c.name.length)) + 3;
          pushItem(
            "info",
            [
              `aerin v${VERSION} — open-source coding agent`,
              "",
              "Commands:",
              ...cmds.map((c) => `  ${c.name.padEnd(pad)}${c.description}`),
              "",
              "Shortcuts:",
              "  Esc          interrupt the agent · clear the input",
              "  Esc Esc      edit your last message",
              "  Ctrl+O       expand the last tool output",
              "  Shift+Tab    cycle mode: manual → accept edits → plan",
              "  Tab          complete /commands and @file paths",
              "  Home/End · Ctrl+←/→   cursor jumps (words, line edges)",
              "  \\ + Enter    insert a newline (Alt+Enter too)",
              "  PgUp/PgDn    scroll the transcript (mouse wheel works)",
              "  @path        attach a file to your message",
              "  Ctrl+C ×2    quit",
            ].join("\n"),
          );
          return;
        }
        case "/clear": {
          await setup.agent.clear();
          setItems([bannerItem(modelId, nextKey.current++)]); // fresh start looks like startup
          setScrollOffset(0);
          setCtxTokens(0);
          setStats({ inTok: 0, outTok: 0, cost: 0 });
          setTodos([]);
          setGoalSet(false); // agent.clear() dropped the goal — sync the indicator
          return;
        }
        case "/undo":
          pushItem("info", await undoCommand(setup));
          return;
        case "/redo":
          pushItem("info", await redoCommand(setup));
          return;
        case "/connect": {
          const [prov, key] = arg.split(/\s+/);
          if (prov && key) {
            await saveConnection(prov, key, catalogEntry(prov)?.baseURL);
            return;
          }
          setConnect({ step: "pick", dynamic: await modelsDevProviders().catch(() => []) });
          return;
        }
        case "/status": {
          const freeTier = catalogEntry(modelId.split("/")[0] ?? "")?.freeTier;
          const jobs = listJobs();
          const running = jobs.filter((j) => j.running);
          pushItem(
            "info",
            statusCommand(setup, {
              modelId,
              version: VERSION,
              contextWindow: modelInfo(modelId).contextWindow,
              ctxTokens,
              cwdDisplay: shortenPath(setup.cwd, 60),
              costLine: `${fmtTokens(stats.inTok)}↑ ${fmtTokens(stats.outTok)}↓${freeTier ? " · free tier — not billed" : stats.cost > 0 ? ` · $${stats.cost.toFixed(4)}` : ""}`,
              ...(latestVersion ? { latestVersion } : {}),
              jobsLine:
                running.length > 0
                  ? running.map((j) => `${j.id} (${j.command.slice(0, 30)})`).join(", ")
                  : jobs.length > 0
                    ? `${jobs.length} finished`
                    : "none",
            }),
          );
          return;
        }
        case "/skills":
          pushItem("info", skillsCommand(setup));
          return;
        case "/mcp":
          pushItem("info", mcpCommand(setup));
          return;
        case "/goal": {
          const res = goalCommand(setup, arg);
          pushItem("info", res.message);
          setGoalSet(Boolean(setup.agent.currentGoal));
          if (res.run) void runTurn(res.run);
          return;
        }
        case "/plan":
          setMode(togglePlan(setup));
          return;
        case "/compact": {
          const r = await compactCommand(setup);
          if (r.contextTokens > 0) setCtxTokens(r.contextTokens);
          pushItem("info", r.message);
          return;
        }
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/resume": {
          if (arg) {
            await resumeSession(arg);
            return;
          }
          // Empty sessions are noise — only offer conversations with content.
          const sessions = (await SessionStore.list(setup.cwd)).filter((s) => s.messageCount > 0);
          if (sessions.length === 0) {
            pushItem("info", "(no previous conversations in this directory)");
            return;
          }
          setSessionPicker(sessions);
          return;
        }
        case "/model": {
          if (arg) {
            switchModel(arg);
            return;
          }
          await openModelPicker();
          return;
        }
        default: {
          const custom = setup.customCommands.find((c) => `/${c.name}` === cmd);
          if (custom) {
            void runTurn(renderCommand(custom, arg), `${cmd}${arg ? ` ${arg}` : ""}`);
            return;
          }
          pushItem("error", `Unknown command: ${cmd}. Try /help.`);
        }
      }
    },
    [setup, pushItem, exit, resumeSession, runTurn, openModelPicker, saveConnection],
  );

  // A failing command must never take down the TUI (or vanish silently).
  const runCommand = useCallback(
    (line: string): void => {
      handleCommand(line).catch((err) => pushItem("error", err instanceof Error ? err.message : String(err)));
    },
    [handleCommand, pushItem],
  );

  const switchModel = useCallback(
    (id: string) => {
      try {
        const model = setup.resolveModelFn(id);
        setup.agent.setModel(model, id);
        setModelId(id);
        setRecentModels((prev) => [id, ...prev.filter((m) => m !== id)].slice(0, 5));
        void persistModelChoice(id).catch(() => {}); // sticky across sessions; best effort
        pushItem("info", `Model switched to ${id}`);
      } catch (err) {
        pushItem("error", err instanceof Error ? err.message : String(err));
      }
    },
    [setup, pushItem],
  );

  // (exit() and abort() are stable; used directly inside onSubmit below)
  const onSubmit = useCallback(
    (value: string) => {
      const line = value.trim();
      if (!line) return;
      // Exit is never queued — it aborts whatever is running and quits now.
      if (line === "/exit" || line === "/quit") {
        setup.agent.abort();
        exit();
        return;
      }
      setInputHistory((h) => (h[h.length - 1] === line ? h : [...h, line].slice(-100)));
      if (workingRef.current) {
        if (line.startsWith("/")) {
          // Commands can't run mid-turn — they queue for after and show as a
          // dim stack above the input (Claude Code-style) until they run.
          setQueued((q) => [...q, line]);
        } else {
          // Claude Code-style: the message is injected INTO the running turn.
          pushItem("user", redactSecrets(line));
          setup.agent.inject(line);
        }
        return;
      }
      if (line.startsWith("/")) {
        runCommand(line);
      } else {
        void runTurn(line);
      }
    },
    [runCommand, runTurn, pushItem, setup, exit],
  );

  // A pending dialog blocks the agent loop on an unresolved promise — resolve
  // it before aborting or the turn can never finish.
  const settleDialogs = useCallback(() => {
    setPermission((prev) => {
      prev?.resolve({ kind: "deny", reason: "Interrupted." });
      return null;
    });
    setQuestion((prev) => {
      prev?.resolve("");
      return null;
    });
    setQuestionOther(false);
  }, []);

  // Global keys: Esc interrupts; Shift+Tab cycles modes; double Ctrl+C exits.
  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      const last = lastToolResultRef.current;
      if (last) {
        const lines = last.output.split("\n");
        const shown = lines.length > 300 ? [...lines.slice(0, 300), `[… ${lines.length - 300} more lines]`] : lines;
        pushItem(last.isError ? "tool-error" : "info", `  └ ${last.summary} — full output:\n${shown.join("\n")}`);
        lastToolResultRef.current = null; // one-shot: re-arms on the next tool result
      }
      return;
    }
    if (key.tab && key.shift) {
      // manual → accept edits → plan → manual (Claude Code order).
      // The status-bar badge and input border announce the mode — no chat spam.
      setMode(cycleMode(setup));
      return;
    }
    if (key.pageUp) {
      scrollBy(Math.max(3, viewportHRef.current - 2));
      return;
    }
    if (key.pageDown) {
      scrollBy(-Math.max(3, viewportHRef.current - 2));
      return;
    }
    if (key.escape && workingRef.current) {
      settleDialogs();
      setup.agent.abort();
      return;
    }
    if (key.ctrl && input === "c") {
      // First press interrupts any running turn AND arms exit; a second press
      // within 1.5s quits immediately — no waiting out the abort.
      if (workingRef.current) {
        settleDialogs();
        setup.agent.abort();
      }
      if (exitArmed) {
        setup.agent.abort();
        exit();
      } else {
        setExitArmed(true);
        setTimeout(() => setExitArmed(false), 1500);
      }
    }
  });

  useEffect(() => {
    // A session continued via -c/-r arrives with history — show it.
    if (setup.agent.history.length > 0) {
      pushItem("info", `── continuing conversation (${setup.agent.history.length} messages) ──`);
      replayHistory(setup.agent.history);
      setCtxTokens(setup.agent.estimateContextTokens());
    }
    // With no usable model the startup warning already says to run /model;
    // keep the input active (auto-opening the picker would swallow typed
    // commands) and skip any initial prompt — the stub model can't run it.
    if (props.initialPrompt && !setup.modelUnavailable) void runTurn(props.initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The input stays visible and typable even while the agent works — messages
  // submitted mid-turn are queued and sent when the turn finishes. Only modal
  // dialogs take the input away.
  const inputActive = !permission && !modelPicker && !sessionPicker && !question && !connect;

  const allCommands = [
    ...SLASH_COMMANDS,
    ...setup.customCommands.map((c) => ({ name: `/${c.name}`, description: c.description })),
  ];

  // Flat VISUAL-row buffer of the transcript — the unit of scrolling (see
  // scroll.ts). Includes the LIVE streaming text, so output keeps flowing
  // (and stays reachable) while scrolled back.
  const [viewportH, setViewportH] = useState(10);
  const flatLines = React.useMemo(
    () => buildFlatLines(items, streaming, size.columns),
    [items, streaming, size.columns],
  );
  const flatLinesRef = useRef(flatLines);
  flatLinesRef.current = flatLines;
  const viewportHRef = useRef(viewportH);
  viewportHRef.current = viewportH;

  // Anchor the view while scrolled back: as new lines stream in below, grow
  // the offset by the same amount so the text on screen doesn't shift. At the
  // bottom (offset 0) we keep following live output. Shrinking transcripts
  // (/clear, /compact) clamp the offset back into range.
  const prevLineCountRef = useRef(0);
  useEffect(() => {
    const delta = flatLines.length - prevLineCountRef.current;
    prevLineCountRef.current = flatLines.length;
    if (delta === 0) return;
    setScrollOffset((o) => anchorOffset(o, delta, flatLines.length, viewportHRef.current));
  }, [flatLines.length]);

  const scrollBy = useCallback((deltaLines: number) => {
    setScrollOffset((o) => stepScroll(o, deltaLines, flatLinesRef.current, viewportHRef.current));
  }, []);

  // Mouse wheel scrolls the transcript one row per event (a notch is ~3
  // events — native terminal feel). Events are coalesced on a ~16ms frame so
  // a fast spin applies as a few larger hops instead of queueing dozens of
  // renders that keep playing after the wheel stops. Pickers own the wheel.
  const pickerOpenRef = useRef(false);
  const wheelAcc = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const m = setup.mouse;
    if (!m) return;
    const onWheel = (dir: number): void => {
      if (pickerOpenRef.current) return;
      wheelAcc.current += dir < 0 ? 1 : -1;
      wheelTimer.current ??= setTimeout(() => {
        wheelTimer.current = null;
        const delta = wheelAcc.current;
        wheelAcc.current = 0;
        if (delta !== 0) scrollBy(delta);
      }, 16);
    };
    m.on("wheel", onWheel);
    return () => {
      m.off("wheel", onWheel);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = null;
      wheelAcc.current = 0;
    };
  }, [setup.mouse, scrollBy]);
  pickerOpenRef.current = Boolean(
    (modelPicker && modelPicker !== "loading") || sessionPicker || connect?.step === "pick",
  );

  // Caps keep the bottom section from squeezing the transcript viewport away.
  const shownSubagents = [...subagents.entries()].slice(0, 4);
  const shownTodos = todos.length > 6 ? todos.slice(0, 6) : todos;
  const shownQueued = queued.length > 3 ? queued.slice(-3) : queued;

  // Transcript alignment: content flows from the top while it fits; once it
  // outgrows the viewport it bottom-aligns so the newest line stays visible
  // above the input and old lines clip at the top.
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const v = viewportRef.current ? measureElement(viewportRef.current).height : 0;
    const c = contentRef.current ? measureElement(contentRef.current).height : 0;
    const next = v > 0 && c > v;
    setOverflowing((prev) => (prev === next ? prev : next));
    if (v > 0) setViewportH((prev) => (prev === v ? prev : v));
  });

  return (
    <Box flexDirection="column" height={usableRows} width={size.columns}>
      {/* Transcript viewport: top-aligned while content fits; once it
          overflows, newest content sticks to the bottom and old lines clip
          away at the top. Scrolled back (offset > 0), an exact line window
          over flatLines renders instead — including live streaming lines. */}
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        overflowY="hidden"
        justifyContent={overflowing && scrollOffset === 0 ? "flex-end" : "flex-start"}
      >
        {scrollOffset > 0 ? (
          scrollWindow(flatLines, scrollOffset, viewportH).map((l) => (
              <Box key={l.key} flexShrink={0}>
                <Text
                  wrap="truncate-end"
                  bold={l.kind === "user"}
                  color={
                    l.kind === "user"
                      ? C.fg
                      : l.kind === "error" || l.kind === "tool-error"
                        ? C.error
                        : l.kind === "info"
                          ? C.dim
                          : undefined
                  }
                >
                  {l.text || " "}
                </Text>
              </Box>
          ))
        ) : (
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {items.slice(-VIEWPORT_ITEMS).map((item) => (
          <Box
            key={item.key}
            marginBottom={item.kind === "assistant" || item.kind === "user" ? 1 : 0}
            flexShrink={0}
          >
            <Text
              bold={item.kind === "user"}
              color={
                item.kind === "user"
                  ? C.fg
                  : item.kind === "error" || item.kind === "tool-error"
                    ? C.error
                    : item.kind === "info"
                      ? C.dim
                      : undefined
              }
            >
              {item.kind === "user" ? prefixUserLines(item.text) : item.text}
            </Text>
          </Box>
        ))}
      {streaming ? (
        <Box flexShrink={0}>
          <Text>{streaming}</Text>
        </Box>
      ) : null}
      {thinking && reasoningTail ? (
        <Box flexDirection="column" marginBottom={0}>
          <Text>
            <Text color={C.accentBright}>✻ </Text>
            <Text color={C.magenta} italic>
              {reasoningTail}
            </Text>
          </Text>
        </Box>
      ) : null}
      {subagents.size > 0 ? (
        <Box flexDirection="column">
          {shownSubagents.map(([id, s]) => (
            <Text key={id} color={C.dim}>
              {"  "}» {s.description} — {s.toolCalls} tools · {s.lastTool ?? "starting"}
            </Text>
          ))}
          {subagents.size > shownSubagents.length ? (
            <Text color={C.dim}>{"  "}» +{subagents.size - shownSubagents.length} more agents</Text>
          ) : null}
        </Box>
      ) : null}
      {todos.length > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.dim} paddingX={1} alignSelf="flex-start">
          {shownTodos.map((t, i) => (
            <Text key={i} color={t.status === "done" ? C.ok : t.status === "active" ? C.accent : C.dim}>
              {t.status === "done" ? "[x]" : t.status === "active" ? "[>]" : "[ ]"} {t.text}
            </Text>
          ))}
          {todos.length > shownTodos.length ? (
            <Text color={C.dim}>… +{todos.length - shownTodos.length} more</Text>
          ) : null}
        </Box>
      ) : null}
      {working && !permission && !question ? (
        <Box flexShrink={0}>
          <Spinner
            label={thinking ? "thinking — Esc to interrupt" : "working — Esc to interrupt"}
            since={turnStartRef.current}
          />
        </Box>
      ) : null}
        </Box>
        )}
      </Box>

      {/* Bottom section: dialogs, input, status — pinned by layout. */}
      <Box flexDirection="column" flexShrink={0}>
      {permission && !denyReasonMode ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.fg} paddingX={1}>
          <Text bold color={C.fg}>Permission: {permission.req.summary}</Text>
          {permission.req.preview ? (
            <DiffText diff={permission.req.preview} maxLines={Math.max(4, Math.min(25, size.rows - 12))} />
          ) : null}
          <SelectList
            active={true}
            items={[
              { label: "Yes", value: "allow" },
              { label: "Yes, always for this project", value: "always" },
              { label: "No — tell the agent what to do instead", value: "deny" },
            ]}
            onSelect={(v) => {
              if (v === "allow") {
                permission.resolve({ kind: "allow" });
                setPermission(null);
              } else if (v === "always") {
                permission.resolve({ kind: "allow-always", scope: "project" });
                setPermission(null);
              } else {
                setDenyReasonMode(true);
              }
            }}
          />
        </Box>
      ) : null}

      {permission && denyReasonMode ? (
        <Box borderStyle="round" borderColor={C.error} paddingX={1}>
          <LineInput
            prompt="Why / what instead? "
            active={true}
            onSubmit={(reason) => {
              permission.resolve({ kind: "deny", ...(reason.trim() ? { reason: reason.trim() } : {}) });
              setPermission(null);
              setDenyReasonMode(false);
            }}
          />
        </Box>
      ) : null}

      {question && !questionOther ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>? {question.q}</Text>
          <SelectList
            active={true}
            items={[
              ...question.options.map((o) => ({ label: o, value: o })),
              { label: "✎ type a different answer", value: "__other__" },
            ]}
            onSelect={(v) => {
              if (v === "__other__") {
                setQuestionOther(true);
              } else {
                question.resolve(v);
                setQuestion(null);
              }
            }}
          />
        </Box>
      ) : null}

      {question && questionOther ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt="answer: "
            active={true}
            onSubmit={(answer) => {
              question.resolve(answer.trim());
              setQuestion(null);
              setQuestionOther(false);
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "pick" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Connect a provider — type to filter, Enter to pick, Esc to cancel</Text>
          <FilterSelect
            active={true}
            {...(setup.mouse ? { wheel: setup.mouse } : {})}
            items={[
              { label: "Featured", value: "__header_featured", header: true },
              ...PROVIDER_CATALOG.map((e) => ({
                label: `${e.name}${e.freeTier ? " · free tier" : ""}${resolveApiKey(e.id, setup.config) ? "  ✓ connected" : ""}`,
                value: e.id,
              })),
              { label: "Custom OpenAI-compatible endpoint…", value: "__custom__" },
              ...(connect.dynamic.length > 0
                ? [{ label: `All providers — models.dev (${connect.dynamic.length})`, value: "__header_all", header: true }]
                : []),
              ...connect.dynamic
                .filter((d) => !catalogEntry(d.id))
                .map((d) => ({
                  label: `${d.name}${d.protocol === "anthropic" ? "  · anthropic API" : ""}${setup.config.providers?.[d.id]?.apiKey ? "  ✓ connected" : ""}`,
                  value: `dyn:${d.id}`,
                })),
            ]}
            onCancel={() => setConnect(null)}
            onSelect={(v) => {
              if (v === "__custom__") {
                setConnect({ step: "custom-name" });
                return;
              }
              if (v.startsWith("dyn:")) {
                const d = connect.dynamic.find((x) => `dyn:${x.id}` === v);
                if (!d) return setConnect(null);
                setConnect({ step: "key", id: d.id, label: d.name, baseURL: d.baseURL, ...(d.protocol ? { protocol: d.protocol } : {}) });
                return;
              }
              const entry = catalogEntry(v);
              if (!entry) return setConnect(null);
              if (!entry.needsKey) {
                setConnect(null);
                void saveConnection(entry.id, "", entry.baseURL, entry.protocol);
                return;
              }
              setConnect({
                step: "key",
                id: entry.id,
                label: entry.name,
                ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
                ...(entry.protocol ? { protocol: entry.protocol } : {}),
              });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "key" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt={`${connect.label} API key (Enter empty to cancel): `}
            active={true}
            onSubmit={(raw) => {
              const key = raw.trim();
              const { id, baseURL, protocol } = connect;
              setConnect(null);
              if (!key) return pushItem("info", "(connect cancelled)");
              void saveConnection(id, key, baseURL, protocol);
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-name" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt="provider name, lowercase (Enter empty to cancel): "
            active={true}
            onSubmit={(raw) => {
              const id = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
              if (!id) {
                setConnect(null);
                return pushItem("info", "(connect cancelled)");
              }
              setConnect({ step: "custom-protocol", id });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-protocol" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Wire protocol for {connect.id} — Esc to cancel</Text>
          <FilterSelect
            active={true}
            {...(setup.mouse ? { wheel: setup.mouse } : {})}
            items={[
              { label: "OpenAI-compatible (default — most providers)", value: "openai" },
              { label: "Anthropic-compatible (Messages API)", value: "anthropic" },
            ]}
            onCancel={() => setConnect(null)}
            onSelect={(v) => {
              const { id } = connect;
              setConnect({ step: "custom-url", id, protocol: v as ConnectProtocol });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-url" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt={`base URL for ${connect.id} (e.g. https://host/v1): `}
            active={true}
            onSubmit={(raw) => {
              const baseURL = raw.trim();
              const { id, protocol } = connect;
              if (!/^https?:\/\//.test(baseURL)) {
                setConnect(null);
                return pushItem("info", "(connect cancelled — base URL must start with http)");
              }
              setConnect({ step: "custom-key", id, baseURL, protocol });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-key" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt={`${connect.id} API key (Enter empty if none, e.g. local): `}
            active={true}
            onSubmit={(raw) => {
              const { id, baseURL, protocol } = connect;
              setConnect(null);
              void saveConnection(id, raw.trim(), baseURL, protocol);
            }}
          />
        </Box>
      ) : null}

      {modelPicker === "loading" ? (
        <Text color={C.dim}>… fetching available models from your providers</Text>
      ) : null}

      {modelPicker && modelPicker !== "loading" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Pick a model (current: {modelId}) — type to filter, Esc to cancel</Text>
          <FilterSelect
            active={true}
            {...(setup.mouse ? { wheel: setup.mouse } : {})}
            items={buildPickerItems(modelPicker, recentModels, modelId)}
            onCancel={() => setModelPicker(null)}
            onSelect={(id) => {
              setModelPicker(null);
              switchModel(id);
            }}
          />
        </Box>
      ) : null}

      {sessionPicker ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Resume a conversation — type to filter, Esc to cancel</Text>
          <FilterSelect
            active={true}
            {...(setup.mouse ? { wheel: setup.mouse } : {})}
            items={sessionPicker.map((s) => ({
              label: `${relativeTime(s.createdAt).padEnd(11)} ${String(s.messageCount).padStart(3)} msg  ${s.title ?? "(no prompt yet)"}`,
              value: s.id,
            }))}
            onCancel={() => setSessionPicker(null)}
            onSelect={(id) => {
              setSessionPicker(null);
              resumeSession(id).catch((err) =>
                pushItem("error", err instanceof Error ? err.message : String(err)),
              );
            }}
          />
        </Box>
      ) : null}

      {queued.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          {queued.length > shownQueued.length ? (
            <Text color={C.dim} dimColor>
              (+{queued.length - shownQueued.length} more queued)
            </Text>
          ) : null}
          {shownQueued.map((q, i) => (
            <Text key={i} color={C.dim} dimColor wrap="truncate-end">
              ❯ {q}
            </Text>
          ))}
        </Box>
      ) : null}

      {inputActive ? (
        <Box
          borderStyle="round"
          borderColor={planMode ? C.magenta : mode === "accept" ? C.ok : working ? C.accentBright : C.dim}
          paddingX={1}
        >
          <LineInput
            prompt="❯ "
            active={inputActive}
            onSubmit={onSubmit}
            history={inputHistory}
            commands={allCommands}
            files={workspaceFiles}
            escActive={!working}
            onScroll={scrollBy}
            recallLast={() => inputHistory[inputHistory.length - 1]}
            placeholder={
              working
                ? "type to steer the agent mid-task — it sees your message right away"
                : "ask anything · @file to attach · / for commands"
            }
          />
        </Box>
      ) : null}

      <Box paddingX={1}>
        <Text>
          <Text color={C.accent}>{modelId.split("/").slice(-1)[0]}</Text>
          {ctxTokens > 0 ? (
            <Text
              color={
                ctxTokens / modelInfo(modelId).contextWindow > 0.8
                  ? C.error
                  : C.dim
              }
            >
              {` · ctx ${Math.round((ctxTokens / modelInfo(modelId).contextWindow) * 100)}%`}
            </Text>
          ) : null}
          <Text color={C.dim}>
            {" · "}
            {fmtTokens(stats.inTok)}↑ {fmtTokens(stats.outTok)}↓
            {stats.cost > 0 ? ` · $${stats.cost.toFixed(stats.cost < 0.1 ? 4 : 2)}` : ""}
          </Text>
          {goalSet ? <Text color={C.accent}> · goal</Text> : null}
          {planMode ? <Text color={C.magenta}> · plan (shift+tab)</Text> : null}
          {mode === "accept" ? <Text color={C.ok}>{" · >> accept edits (shift+tab)"}</Text> : null}
          {scrollOffset > 0 ? <Text color={C.dim}> · ↑ scrolled (PgDn)</Text> : null}
          {exitArmed ? <Text color={C.error}> · Ctrl+C again to exit</Text> : null}
        </Text>
      </Box>
      </Box>
    </Box>
  );
}
