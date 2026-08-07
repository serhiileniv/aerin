import { APICallError, streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AgentEvent, OnPermission } from "./events.js";
import type { ToolDef, ToolContext } from "../tools/types.js";
import { PermissionPolicy, targetFor } from "../permissions/policy.js";
import { persistProjectRule } from "../config/config.js";
import { estimateCostUsd } from "../providers/models.js";
import { shouldCompact, compact } from "./compact.js";
import { modelFamilyGuidance } from "./system-prompt.js";
import { judgeGoal } from "./goal-judge.js";
import { Checkpoints } from "./checkpoints.js";
import { ShadowGit } from "./shadow-git.js";
import { hookFor, runHook, runPreHook, runPostHook, runLifecycleHook } from "./hooks.js";
import path from "node:path";
import type { SessionStore } from "../session/store.js";

const MAX_ITERATIONS = 50;
/** Extra whole-request retries when the stream fails before producing content. */
const MAX_STREAM_RETRIES = 2;

/**
 * Errors where a DIFFERENT provider can still serve the request: everything
 * retryable, plus exhausted quotas/billing (pointless to retry same-provider,
 * exactly what a fallback chain is for). Auth/validation errors stay fatal —
 * they need the user, not another model.
 */
export function isFailoverEligible(err: unknown): boolean {
  if (isRetryableError(err)) return true;
  return /per.day|daily|quota|insufficient.credit|billing|payment|overloaded/.test(errorMessage(err).toLowerCase());
}

/** Transient provider failures worth retrying: rate limits, overload, network. */
export function isRetryableError(err: unknown): boolean {
  // Exhausted quotas won't recover in seconds — retrying just wastes a minute.
  const raw = errorMessage(err).toLowerCase();
  if (/per.day|daily|quota|insufficient.credit|billing|payment/.test(raw)) return false;
  if (APICallError.isInstance(err)) {
    if (err.isRetryable) return true;
    const sc = err.statusCode;
    if (sc !== undefined && [408, 409, 429, 500, 502, 503, 529].includes(sc)) return true;
  }
  const msg = errorMessage(err).toLowerCase();
  if (/overloaded|rate.?limit|too many requests|timed? ?out|econnreset|econnrefused|fetch failed|socket|network error/.test(msg)) {
    return true;
  }
  return /\b(429|500|502|503|529)\b/.test(msg);
}

/**
 * Strip non-JSON values (undefined properties, class instances) from
 * provider-returned messages. Some providers (seen: OpenRouter's
 * reasoning_details) attach `undefined` fields inside providerOptions,
 * which fails the AI SDK's ModelMessage validation on the NEXT request —
 * and would corrupt our JSONL session files anyway.
 */
export function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Attach provider context and an actionable hint to a raw provider error. */
export function enrichProviderError(modelId: string, message: string): string {
  const provider = modelId.split("/")[0] ?? "provider";
  let hint = "";
  if (/invalid.?api.?key|unauthorized|authentication|\b401\b|\b403\b/i.test(message)) {
    hint = ` — check your ${provider} key: /connect ${provider}`;
  } else if (/per.day|daily|quota|insufficient.credit|billing|payment/i.test(message)) {
    hint = ` — ${provider} quota or billing limit; try another model (/model)`;
  } else if (/rate.?limit|too many requests|\b429\b/i.test(message)) {
    hint = ` — ${provider} rate limit; wait a moment or switch models (/model)`;
  } else if (/tool.?calling.*not supported|does not support (tool|chat completion)/i.test(message)) {
    hint = ` — this model cannot work as a coding agent; pick a tool-capable chat model (/model)`;
  } else if (/model.*(not.?found|does.?not.?exist|decommissioned|deprecated)/i.test(message)) {
    hint = ` — that model id may be wrong or retired; pick another (/model)`;
  }
  return `[${modelId}] ${message}${hint}`;
}

/**
 * Drop reasoning ("thinking") parts from an assistant message before storing
 * it. They are streamed to the UI live, but replaying them in history breaks
 * strict providers (Groq rejects `reasoning_content` outright), and no
 * provider we call requires them back.
 */
export function stripReasoningParts(m: ModelMessage): ModelMessage {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
  const content = (m.content as { type?: string }[]).filter((p) => p?.type !== "reasoning");
  return { ...m, content } as ModelMessage;
}

/** Providers throw strings, Errors, and bare objects — normalize to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o["message"] === "string") return o["message"];
    if (typeof o["error"] === "object" && o["error"] !== null) {
      const inner = o["error"] as Record<string, unknown>;
      if (typeof inner["message"] === "string") return inner["message"];
    }
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Messages newer than this stay intact; older tool outputs get elided. */
const PRUNE_KEEP_TAIL = 20;
/** Only outputs bigger than this are worth eliding. */
const PRUNE_MIN_CHARS = 1500;

/**
 * Replace bulky tool outputs in the old part of a conversation with a stub.
 * Stale file dumps and command output are the main context hogs; the model
 * can always re-run a tool if it truly needs the data again. Returns a new
 * array — stored history is never mutated.
 */
export function pruneOldToolResults(messages: ModelMessage[], keepTail: number = PRUNE_KEEP_TAIL): ModelMessage[] {
  const cut = messages.length - keepTail;
  if (cut <= 0) return messages;
  return messages.map((m, i) => {
    if (i >= cut || m.role !== "tool" || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = (m.content as { output?: { type?: string; value?: unknown } }[]).map((part) => {
      const value = part?.output?.value;
      if (typeof value === "string" && value.length > PRUNE_MIN_CHARS) {
        changed = true;
        return {
          ...part,
          output: { ...part.output, value: `[old tool output elided (${value.length} chars) — re-run the tool if needed]` },
        };
      }
      return part;
    });
    return changed ? ({ ...m, content } as ModelMessage) : m;
  });
}

export interface AgentOptions {
  model: LanguageModel;
  modelId: string;
  systemPrompt: string;
  tools: ToolDef[];
  policy: PermissionPolicy;
  onPermission: OnPermission;
  cwd: string;
  allowOutsideCwd: boolean;
  store?: SessionStore;
  initialMessages?: ModelMessage[];
  /** Tool-iteration cap per send(); sub-agents run with a lower cap. */
  maxIterations?: number;
  /** Shell hooks keyed "pre:<tool>"/"post:<tool>" (or "pre:*"/"post:*"). */
  hooks?: Record<string, string>;
  /** Check command run after successful write/edit; failures append to the tool result. */
  diagnosticsCmd?: string;
  /** Deferred tools (schemas hidden from the model), reachable via the tool_call bridge. */
  deferredTools?: Map<string, ToolDef>;
  /** Ordered failover chain tried when the active model fails (config fallbackModels). */
  fallbacks?: { modelId: string; resolve: () => LanguageModel }[];
  /** Turn budget for the /goal loop (default 20). */
  maxGoalTurns?: number;
  /** Cheaper model for goal-loop verdicts; lazy so a bad config surfaces as fail-open, not a crash. */
  getJudgeModel?: () => LanguageModel;
  /**
   * Worker sub-agents share the PARENT's shadow-git via this hook instead of
   * creating their own (two instances on one shadow index would race, and the
   * parent's per-turn snapshot must cover worker writes for /undo).
   */
  getShadow?: () => Promise<ShadowGit | null>;
}

export class Agent {
  private messages: ModelMessage[];
  private toolsByName: Map<string, ToolDef>;
  private lastInputTokens = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCostUsd = 0;
  private currentAbort: AbortController | undefined;
  /** Fallback undo when git is unavailable — write-tool paths only. */
  private checkpoints = new Checkpoints();
  /** Shadow-git undo/redo; created lazily on the first state-changing tool. undefined = not tried, null = git unusable. */
  private shadow: ShadowGit | null | undefined;

  constructor(private opts: AgentOptions) {
    this.messages = [...(opts.initialMessages ?? [])];
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  }

  get history(): readonly ModelMessage[] {
    return this.messages;
  }

  abort(): void {
    this.currentAbort?.abort();
  }

  /** Identical-call loop breaker (opencode's doom_loop): this turn's dispatched calls. */
  private turnToolCalls: { name: string; inputJson: string }[] = [];
  /** Tools the user chose "always continue" for after a doom-loop prompt (session-scoped). */
  private doomLoopApproved = new Set<string>();
  private static readonly DOOM_LOOP_THRESHOLD = 3;

  /** Set when the primary model failed mid-turn and a fallback took over. */
  private failover: { model: LanguageModel; modelId: string } | undefined;
  private failoverIndex = 0;

  /** The model actually serving requests right now (fallback while failed over). */
  private get activeModel(): LanguageModel {
    return this.failover?.model ?? this.opts.model;
  }

  private get activeModelId(): string {
    return this.failover?.modelId ?? this.opts.modelId;
  }

  /** Step down the failover chain; skips the active model and unresolvable entries. */
  private advanceFailover(): { modelId: string } | undefined {
    const list = this.opts.fallbacks ?? [];
    while (this.failoverIndex < list.length) {
      const f = list[this.failoverIndex++] as { modelId: string; resolve: () => LanguageModel };
      if (f.modelId === this.activeModelId) continue;
      try {
        this.failover = { model: f.resolve(), modelId: f.modelId };
        return this.failover;
      } catch {
        continue; // no key / bad id — try the next one
      }
    }
    return undefined;
  }

  setModel(model: LanguageModel, modelId: string): void {
    this.opts.model = model;
    this.opts.modelId = modelId;
    // A deliberate model switch supersedes any failover state.
    this.failover = undefined;
    this.failoverIndex = 0;
  }

  get modelId(): string {
    return this.opts.modelId;
  }

  get model(): LanguageModel {
    return this.opts.model;
  }

  /** Register a tool after construction — needed by tools that close over this Agent. */
  registerTool(def: ToolDef): void {
    this.opts.tools.push(def);
    this.toolsByName.set(def.name, def);
  }

  async clear(): Promise<void> {
    this.messages = [];
    // A cleared session is a fresh start — the cost/token meter resets with
    // it, and so does the goal (clearing also disarms the goal loop).
    this.setGoal(undefined);
    this.lastInputTokens = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUsd = 0;
    await this.opts.store?.rewrite([]);
  }

  /** Swap in a previously saved session (store + full message history). */
  loadSession(store: SessionStore, messages: ModelMessage[]): void {
    this.opts.store = store;
    this.messages = [...messages];
  }

  /**
   * The shadow-git instance for this agent's cwd — own (lazily created) for
   * the main agent, the parent's for worker sub-agents. null = git unusable.
   */
  async ensureShadow(): Promise<ShadowGit | null> {
    if (this.opts.getShadow) return this.opts.getShadow();
    if (this.shadow === undefined) this.shadow = await ShadowGit.create(this.opts.cwd);
    return this.shadow;
  }

  /** Undo the file changes of the most recent turn that changed anything. */
  async undo(): Promise<string[]> {
    if (this.shadow) return this.shadow.undoLastChange();
    return this.checkpoints.undoLastChange();
  }

  /** Re-apply the changes reverted by the most recent /undo (shadow git only). */
  async redo(): Promise<string[]> {
    return this.shadow ? this.shadow.redoLastUndo() : [];
  }

  private injected: string[] = [];

  /**
   * Deliver a user message INTO the running turn, Claude Code-style: it is
   * appended after the next batch of tool results (or before a final answer),
   * so the model sees it mid-task and adjusts course without a new turn.
   */
  inject(text: string): void {
    this.injected.push(text);
  }

  private drainInjected(newMessages: ModelMessage[]): boolean {
    if (this.injected.length === 0) return false;
    for (const text of this.injected.splice(0)) {
      const m: ModelMessage = {
        role: "user",
        content: `[The user sent this while you were working — address it as you continue:]\n${text}`,
      };
      this.messages.push(m);
      newMessages.push(m);
    }
    return true;
  }

  private goal: string | undefined;
  /** Remaining autonomous continuations for the /goal loop; 0 = loop disarmed. */
  private goalTurnsLeft = 0;

  /** Pin a user-set session goal into every request's system prompt. */
  setGoal(goal: string | undefined): void {
    this.goal = goal?.trim() || undefined;
    if (!this.goal) this.goalTurnsLeft = 0;
  }

  /**
   * Arm the autonomous goal loop: after each finished turn a judge decides
   * whether the goal is met; if not, the agent continues on its own, up to
   * the turn budget. User messages and /goal clear always take precedence.
   */
  startGoal(goal: string): void {
    this.setGoal(goal);
    this.goalTurnsLeft = this.goal ? (this.opts.maxGoalTurns ?? 20) : 0;
  }

  get currentGoal(): string | undefined {
    return this.goal;
  }

  /** Judge model for goal verdicts: configured cheap model when resolvable, else the active model. */
  private judgeModel(): LanguageModel {
    try {
      return this.opts.getJudgeModel?.() ?? this.activeModel;
    } catch {
      return this.activeModel;
    }
  }

  private effectiveSystemPrompt(): string {
    // Family guidance resolves from the CURRENT model — /model switches and
    // mid-turn failovers swap the addendum along with the model.
    const tuning = modelFamilyGuidance(this.activeModelId);
    const base = tuning ? `${this.opts.systemPrompt}\n\n${tuning}` : this.opts.systemPrompt;
    return this.goal
      ? `${base}\n\nSession goal (set by the user — keep every action pointed at it):\n${this.goal}`
      : base;
  }

  async compactNow(): Promise<void> {
    // compact:pre lifecycle hook — observational (logging, snapshots).
    if (this.opts.hooks?.["compact:pre"]) {
      await runLifecycleHook(
        this.opts.hooks,
        "compact:pre",
        { preTokens: this.lastInputTokens, messages: this.messages.length },
        this.opts.cwd,
      );
    }
    // Active model: while failed over, the primary can't serve the summary call either.
    this.messages = await compact(this.activeModel, this.activeModelId, this.messages);
    await this.opts.store?.rewrite(this.messages);
    // The old provider-reported context size no longer describes this history;
    // without the reset, shouldCompact() would re-fire on the next turn.
    this.lastInputTokens = 0;
  }

  /** Rough size of the current history (~4 chars/token) — for the meter between requests. */
  estimateContextTokens(): number {
    return Math.round(JSON.stringify(this.messages).length / 4);
  }


  /**
   * Request prompt fields. Non-Anthropic models get the plain `system` option.
   * Anthropic models get the system prompt as a message with cache breakpoints
   * on it and on the latest message (plus allowSystemInMessages, the sanctioned
   * form), so the unchanged prefix bills at the cached rate (~10%) on every
   * iteration. Clones — never mutates — stored history, so the moving
   * breakpoint is not persisted to the session file.
   */
  private requestPrompt(): {
    system?: string;
    messages: ModelMessage[];
    allowSystemInMessages?: boolean;
  } {
    const pruned = pruneOldToolResults(this.messages);
    const systemPrompt = this.effectiveSystemPrompt();
    if (!this.activeModelId.startsWith("anthropic/")) {
      return { system: systemPrompt, messages: pruned };
    }
    const cacheOpts = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const withCache = (m: ModelMessage): ModelMessage =>
      ({ ...m, providerOptions: { ...(m as { providerOptions?: object }).providerOptions, ...cacheOpts } }) as ModelMessage;
    const system = withCache({ role: "system", content: systemPrompt } as ModelMessage);
    const last = pruned[pruned.length - 1];
    const messages = last ? [system, ...pruned.slice(0, -1), withCache(last)] : [system];
    return { messages, allowSystemInMessages: true };
  }

  /** Declare tool schemas only — never `execute` — so the permission gate interposes. */
  private buildToolSet(): ToolSet {
    const set: ToolSet = {};
    for (const t of this.opts.tools) {
      set[t.name] = aiTool({ description: t.description, inputSchema: t.inputSchema });
    }
    return set;
  }

  async *send(
    input: string,
    images?: readonly { data: string; mediaType: string }[],
  ): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.currentAbort = abort;
    this.injected.length = 0; // a fresh prompt supersedes stale mid-turn notes
    // Each turn re-probes the primary model; failover state never outlives a turn.
    this.failover = undefined;
    this.failoverIndex = 0;
    this.turnToolCalls.length = 0; // doom-loop tracking is per turn

    // prompt:submit lifecycle hook — can veto the prompt or enrich it.
    if (this.opts.hooks?.["prompt:submit"]) {
      const r = await runLifecycleHook(this.opts.hooks, "prompt:submit", { prompt: input }, this.opts.cwd);
      if (r?.blockReason) {
        yield { type: "error", message: `Prompt blocked by prompt:submit hook: ${r.blockReason}` };
        return;
      }
      if (r?.context) input = `${input}\n\n[context from prompt:submit hook]\n${r.context}`;
    }

    const newMessages: ModelMessage[] = [];
    const userMessage: ModelMessage =
      images && images.length > 0
        ? ({
            role: "user",
            content: [
              { type: "text", text: input },
              ...images.map((i) => ({ type: "image" as const, image: i.data, mediaType: i.mediaType })),
            ],
          } as ModelMessage)
        : { role: "user", content: input };
    this.messages.push(userMessage);
    newMessages.push(userMessage);
    await this.opts.store?.ensureTitle(input);
    this.checkpoints.beginTurn();
    this.shadow?.beginTurn();

    const toolCtx: ToolContext = {
      cwd: this.opts.cwd,
      abortSignal: abort.signal,
      allowOutsideCwd: this.opts.allowOutsideCwd,
    };

    try {
      const maxIterations = this.opts.maxIterations ?? MAX_ITERATIONS;
      let finished = false;
      let turnEndBlocks = 0; // the turn:end hook can demand more work, at most 3× per turn
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (shouldCompact(this.activeModelId, this.lastInputTokens)) {
          const pre = this.lastInputTokens;
          yield { type: "compaction", preTokens: pre };
          await this.compactNow();
          this.lastInputTokens = 0;
          // compactNow rewrote the session file with the compacted history,
          // which already contains this turn's messages so far — appending
          // them again in the finally would duplicate and resurrect them.
          newMessages.length = 0;
        }

        const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];
        let sawText = false;
        let turnText = ""; // this iteration's assistant text — the goal judge's evidence
        let result!: ReturnType<typeof streamText>;

        // Retry the whole request when the stream dies on a transient provider
        // error BEFORE any content arrived; once content streamed, fail honestly.
        for (let attempt = 0; ; attempt++) {
          result = streamText({
            model: this.activeModel,
            ...this.requestPrompt(),
            tools: this.buildToolSet(),
            abortSignal: abort.signal,
            // Errors surface through our event stream; without this the SDK
            // also dumps the raw error object to the console.
            onError: () => {},
          });

          let received = false;
          try {
            for await (const part of result.fullStream) {
              if (part.type === "text-delta") {
                received = true;
                sawText = true;
                turnText += part.text;
                yield { type: "text-delta", text: part.text };
              } else if (part.type === "reasoning-delta") {
                received = true;
                yield { type: "reasoning-delta", text: part.text };
              } else if (part.type === "tool-call") {
                received = true;
                toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
              } else if (part.type === "error") {
                throw part.error instanceof Error ? part.error : new Error(errorMessage(part.error));
              }
            }
            break;
          } catch (err) {
            if (received || abort.signal.aborted) throw err;
            if (attempt >= MAX_STREAM_RETRIES || !isRetryableError(err)) {
              // Retries exhausted (or a fail-fast error like a spent quota):
              // walk the failover chain before giving up on the turn.
              const from = this.activeModelId;
              if (isFailoverEligible(err) && this.advanceFailover()) {
                toolCalls.length = 0;
                yield {
                  type: "failover",
                  from,
                  to: this.activeModelId,
                  message: errorMessage(err).slice(0, 200),
                };
                attempt = -1; // fresh retry budget for the fallback model
                continue;
              }
              throw err;
            }
            toolCalls.length = 0;
            yield {
              type: "retry",
              attempt: attempt + 1,
              maxAttempts: MAX_STREAM_RETRIES + 1,
              message: errorMessage(err),
            };
            const delay = 1500 * (attempt + 1);
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delay);
              abort.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  resolve();
                },
                { once: true },
              );
            });
          }
        }
        if (sawText) yield { type: "message-end" };

        const response = await result.response;
        const sanitized = response.messages
          .map((m) => toPlainJson(stripReasoningParts(m)))
          // A message that was ONLY reasoning is now empty — drop it entirely.
          .filter((m) => !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0));
        this.messages.push(...sanitized);
        newMessages.push(...sanitized);

        const usage = await result.usage;
        // Cached input is excluded from inputTokens but still occupies context —
        // count it so the meter reflects the true conversation size.
        let inTok = (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
        let outTok = usage.outputTokens ?? 0;
        if (inTok === 0 && outTok === 0) {
          // Local/OpenAI-compatible servers (Ollama, LM Studio, some proxies)
          // often omit usage in streamed responses — estimate at ~4 chars/token
          // so the context meter and totals keep working.
          inTok = this.estimateContextTokens();
          outTok = Math.max(1, Math.round(sanitized.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4));
        }
        this.lastInputTokens = inTok;
        this.totalInputTokens += inTok;
        this.totalOutputTokens += outTok;
        // Projected cost from live pricing; free-tier providers return
        // undefined so no money is ever counted or shown for them.
        const cost = estimateCostUsd(this.activeModelId, inTok, outTok);
        if (cost !== undefined) this.totalCostUsd += cost;
        yield { type: "usage", inputTokens: inTok, outputTokens: outTok, costUsd: cost };

        if (toolCalls.length === 0) {
          // A mid-turn user message arrived after the model finished its
          // answer — keep the turn alive so it gets addressed now.
          if (this.drainInjected(newMessages)) continue;
          // Goal loop: a finished turn is judged against the armed goal; if
          // not done, the agent continues on its own within the turn budget.
          if (this.goal && this.goalTurnsLeft > 0) {
            const verdict = await judgeGoal(
              this.judgeModel(),
              this.goal,
              turnText,
              abort.signal,
            );
            if (abort.signal.aborted) {
              finished = true;
              break;
            }
            this.goalTurnsLeft--;
            const exhausted = !verdict.done && this.goalTurnsLeft === 0;
            yield {
              type: "goal-check",
              done: verdict.done,
              reason: exhausted
                ? `${verdict.reason} — goal turn budget exhausted; /goal again to keep going`
                : verdict.reason,
              turnsLeft: this.goalTurnsLeft,
            };
            if (verdict.done) {
              this.setGoal(undefined); // achieved — disarm loop and unpin
            } else if (!exhausted) {
              const m: ModelMessage = {
                role: "user",
                content:
                  `[goal check] Not complete yet: ${verdict.reason}\n` +
                  `Keep working toward the goal: ${this.goal}\n` +
                  `When it is truly done, state the concrete evidence (test output, diffs, command results).`,
              };
              this.messages.push(m);
              newMessages.push(m);
              iteration = -1; // fresh tool-iteration budget for the next goal turn
              continue;
            }
          }
          // turn:end lifecycle hook — a JSON block verdict sends the agent
          // back to work (e.g. "tests were not run"). Hard-capped so a hook
          // that always blocks cannot trap the turn forever.
          if (this.opts.hooks?.["turn:end"] && turnEndBlocks < 3) {
            const r = await runLifecycleHook(
              this.opts.hooks,
              "turn:end",
              { response: turnText.slice(-4000) },
              this.opts.cwd,
            );
            if (r?.blockReason && !abort.signal.aborted) {
              turnEndBlocks++;
              yield { type: "tool-display", text: `(turn:end hook: ${r.blockReason} — continuing)` };
              const m: ModelMessage = {
                role: "user",
                content: `[turn:end hook] Your turn was rejected: ${r.blockReason}\nAddress this before finishing.`,
              };
              this.messages.push(m);
              newMessages.push(m);
              iteration = -1;
              continue;
            }
          }
          finished = true;
          break;
        }

        const toolResults: ModelMessage = { role: "tool", content: [] };
        // Sub-agent calls are independent read-only research — run a batch of
        // them concurrently; everything else stays strictly sequential.
        const agentCalls = toolCalls.filter((c) => c.toolName === "agent");
        const sequential =
          agentCalls.length > 1 ? toolCalls.filter((c) => c.toolName !== "agent") : toolCalls;
        if (agentCalls.length > 1) {
          yield* this.dispatchParallel(agentCalls, toolCtx, toolResults);
        }
        for (const call of sequential) {
          const { output, isError } = yield* this.dispatchToolCall(call, toolCtx);
          yield { type: "tool-result", id: call.toolCallId, name: call.toolName, output, isError };
          (toolResults.content as unknown[]).push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: isError ? "error-text" : "text", value: output },
          });
        }
        this.messages.push(toolResults);
        newMessages.push(toolResults);
        // Mid-turn user messages ride along with the tool results.
        this.drainInjected(newMessages);
      }
      if (!finished) {
        yield {
          type: "error",
          message: `Stopped after ${maxIterations} tool iterations — say "continue" to keep going.`,
        };
      }
    } catch (err) {
      if (abort.signal.aborted) {
        // Providers reject histories with dangling tool calls, so patch any
        // unanswered calls with synthetic cancelled results before returning.
        this.patchDanglingToolCalls(newMessages);
        yield { type: "error", message: "Interrupted." };
      } else {
        // The ACTIVE model raised this — after a failover that is the fallback,
        // not the primary. Blaming the primary points the user's remediation
        // (/connect <provider>) at a provider whose key was never the problem.
        yield { type: "error", message: enrichProviderError(this.activeModelId, errorMessage(err)) };
      }
    } finally {
      this.currentAbort = undefined;
      await this.opts.store?.append(newMessages).catch(() => {});
    }
    yield { type: "turn-end" };
  }

  /**
   * Drive several dispatch generators concurrently, funneling their events
   * through one queue; results are appended in the original call order.
   * Used only for `agent` (sub-agent) calls: read-tier, so no permission
   * dialogs can interleave.
   */
  private async *dispatchParallel(
    calls: { toolCallId: string; toolName: string; input: unknown }[],
    ctx: ToolContext,
    toolResults: ModelMessage,
  ): AsyncGenerator<AgentEvent, void> {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const outcomes = new Map<string, { output: string; isError: boolean }>();
    let pending = calls.length;
    let abortError: unknown;

    for (const call of calls) {
      void (async () => {
        try {
          const gen = this.dispatchToolCall(call, ctx);
          for (;;) {
            const r = await gen.next();
            if (r.done) {
              outcomes.set(call.toolCallId, r.value);
              return;
            }
            queue.push(r.value);
            wake?.();
          }
        } catch (err) {
          if (ctx.abortSignal?.aborted) abortError ??= err;
          outcomes.set(call.toolCallId, { output: errorMessage(err), isError: true });
        } finally {
          pending--;
          wake?.();
        }
      })();
    }

    while (pending > 0 || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      yield queue.shift() as AgentEvent;
    }
    if (abortError !== undefined) throw abortError;

    for (const call of calls) {
      const res = outcomes.get(call.toolCallId) ?? { output: "(no result)", isError: true };
      yield { type: "tool-result", id: call.toolCallId, name: call.toolName, output: res.output, isError: res.isError };
      (toolResults.content as unknown[]).push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: res.isError ? "error-text" : "text", value: res.output },
      });
    }
  }

  private async *dispatchToolCall(
    call: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
  ): AsyncGenerator<AgentEvent, { output: string; isError: boolean }> {
    // Deferred-tool bridge: translate tool_call(name, args) into the real
    // tool BEFORE anything else, so permissions, deny rules, hooks, and undo
    // snapshots see the actual tool — only the transcript pairing (the
    // caller's toolCallId/toolName) stays on the bridge call.
    if (call.toolName === "tool_call" && this.opts.deferredTools && this.opts.deferredTools.size > 0) {
      const bridge = (call.input ?? {}) as { name?: unknown; args?: unknown };
      const realName = typeof bridge.name === "string" ? bridge.name : "";
      if (!this.opts.deferredTools.has(realName)) {
        return { output: `Unknown deferred tool: "${realName}". Use tool_search to find available tools.`, isError: true };
      }
      let args: unknown = {};
      if (typeof bridge.args === "string" && bridge.args.trim()) {
        try {
          args = JSON.parse(bridge.args);
        } catch {
          return { output: `tool_call args must be a JSON object string. Got: ${String(bridge.args).slice(0, 200)}`, isError: true };
        }
      } else if (bridge.args && typeof bridge.args === "object") {
        args = bridge.args; // some models send the object directly — accept it
      }
      call = { toolCallId: call.toolCallId, toolName: realName, input: args };
    }

    const def = this.toolsByName.get(call.toolName) ?? this.opts.deferredTools?.get(call.toolName);
    if (!def) return { output: `Unknown tool: ${call.toolName}`, isError: true };

    // MCP tools carry a JSON-Schema passthrough instead of zod — skip local validation there.
    const maybeZod = def.inputSchema as {
      safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } };
    };
    let input: unknown = call.input;
    if (typeof maybeZod.safeParse === "function") {
      const parsed = maybeZod.safeParse(call.input);
      if (!parsed.success) {
        // Return the validation error as the tool result so the model self-corrects.
        return { output: `Invalid tool input: ${parsed.error?.message ?? "schema mismatch"}`, isError: true };
      }
      input = parsed.data;
    }
    const summary = def.summarize(input);
    yield { type: "tool-call", id: call.toolCallId, name: call.toolName, input, summary };

    // Doom-loop breaker: the same tool called with byte-identical input for
    // the 4th time in one turn is a stuck retry, whatever the permission tier
    // or mode — surface it to the user before burning more tokens on it.
    const inputJson = JSON.stringify(input ?? null);
    const recent = this.turnToolCalls.slice(-Agent.DOOM_LOOP_THRESHOLD);
    const isDoomLoop =
      recent.length === Agent.DOOM_LOOP_THRESHOLD &&
      recent.every((c) => c.name === call.toolName && c.inputJson === inputJson) &&
      !this.doomLoopApproved.has(call.toolName);
    this.turnToolCalls.push({ name: call.toolName, inputJson });
    if (isDoomLoop) {
      const decision = await this.opts.onPermission({
        tool: call.toolName,
        input,
        summary: `Doom loop: ${summary} repeated ${Agent.DOOM_LOOP_THRESHOLD + 1}× with identical input — continue?`,
      });
      if (decision.kind === "deny") {
        return {
          output:
            `Stopped: you have called ${call.toolName} ${Agent.DOOM_LOOP_THRESHOLD + 1} times with IDENTICAL input` +
            ` — repeating it will not produce a different result.` +
            `${decision.reason ? ` The user says: ${decision.reason}` : ""}` +
            ` Change your approach, or explain what is blocking you.`,
          isError: true,
        };
      }
      if (decision.kind === "allow-always") this.doomLoopApproved.add(call.toolName);
    }

    const target = targetFor(call.toolName, input);
    let policyDecision = this.opts.policy.decide(def.permission, target);
    if (policyDecision === "deny") {
      const denyRule = this.opts.policy.deniedBy(target);
      return {
        output: denyRule
          ? `Denied by permission rule ${denyRule} (permissions.deny in settings). ` +
            "Do not retry or work around this — use a different approach, or ask the user to change the rule."
          : "Plan mode is active: only read-only tools are allowed. Investigate with read/grep/glob/agent, " +
            "then present a numbered step-by-step plan and stop — the user approves by turning plan mode off (/plan).",
        isError: true,
      };
    }
    // Pre-hook runs BEFORE the permission prompt. The JSON protocol can
    // deny, auto-allow, force a prompt, or rewrite the tool input; legacy
    // hooks (non-JSON output) block on non-zero exit as before. Explicit
    // deny rules above beat hooks; a rewritten input is re-checked against
    // the policy so a hook cannot route around a deny rule.
    const preHook = hookFor(this.opts.hooks, "pre", call.toolName);
    if (preHook) {
      const pre = await runPreHook(preHook, call.toolName, input, this.opts.cwd);
      if (pre.decision === "deny") {
        return { output: `Blocked by pre-hook: ${pre.reason ?? "(no reason given)"}`, isError: true };
      }
      if (pre.replacedInput !== undefined) {
        if (typeof maybeZod.safeParse === "function") {
          const reparsed = maybeZod.safeParse(pre.replacedInput);
          if (!reparsed.success) {
            return {
              output: `Pre-hook rewrote the input but it failed validation: ${reparsed.error?.message ?? "schema mismatch"}`,
              isError: true,
            };
          }
          input = reparsed.data;
        } else {
          input = pre.replacedInput;
        }
        policyDecision = this.opts.policy.decide(def.permission, targetFor(call.toolName, input));
        if (policyDecision === "deny") {
          return { output: "The pre-hook's rewritten input is blocked by a permission deny rule.", isError: true };
        }
      }
      if (pre.decision === "allow") policyDecision = "allow";
      else if (pre.decision === "ask") policyDecision = "ask";
    }

    if (policyDecision === "ask") {
      const preview = def.preview ? await def.preview(input, ctx).catch(() => undefined) : undefined;
      const decision = await this.opts.onPermission({
        tool: call.toolName,
        input,
        summary,
        ...(preview !== undefined ? { preview } : {}),
      });
      if (decision.kind === "deny") {
        return {
          output: `User denied permission for this action.${decision.reason ? ` Instruction: ${decision.reason}` : ""}`,
          isError: true,
        };
      }
      if (decision.kind === "allow-always") {
        const rule = PermissionPolicy.ruleFor(target);
        this.opts.policy.addSessionRule(rule);
        if (decision.scope === "project") {
          await persistProjectRule(this.opts.cwd, rule).catch(() => {});
        }
      }
    }

    // Capture pre-change state so /undo can restore this turn. The shadow-git
    // snapshot runs before write AND execute tools, so bash/MCP side effects
    // are covered; without git we fall back to per-file capture on write tools.
    if (def.permission !== "read") {
      const shadow = await this.ensureShadow();
      if (shadow) {
        await shadow.snapshotIfNeeded();
      } else if (def.permission === "write") {
        const p = (input as { path?: unknown })?.path;
        if (typeof p === "string" && p) {
          await this.checkpoints.record(path.resolve(this.opts.cwd, p)).catch(() => {});
        }
      }
    }

    // Pump: run execute() while yielding any progress events it pushes (e.g.
    // sub-agent status), so the UI stays live during long tool runs.
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const progressCtx: ToolContext = {
      ...ctx,
      toolCallId: call.toolCallId,
      onProgress: (e) => {
        queue.push(e);
        wake?.();
      },
    };
    let settled = false;
    let output = "";
    let error: unknown;
    void def
      .execute(input, progressCtx)
      .then(
        (r) => {
          output = r;
        },
        (e: unknown) => {
          error = e ?? new Error("Tool failed.");
        },
      )
      .finally(() => {
        settled = true;
        wake?.();
      });

    while (!settled || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      const e = queue.shift() as AgentEvent;
      // Fold sub-agent spend into this agent's totals so every frontend's
      // meter stays truthful without UI-specific accounting.
      if (e.type === "subagent-update" && e.status !== "running") {
        this.totalInputTokens += e.inputTokens;
        this.totalOutputTokens += e.outputTokens;
        if (e.costUsd !== undefined) this.totalCostUsd += e.costUsd;
      }
      yield e;
    }

    if (error !== undefined) {
      if (ctx.abortSignal?.aborted) throw error;
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }

    // Post-hook: legacy failures and JSON "context" both append to the tool
    // result (e.g. typecheck errors after an edit) so the model sees and
    // fixes the fallout immediately. The hook gets the tool's output on stdin.
    const postHook = hookFor(this.opts.hooks, "post", call.toolName);
    if (postHook) {
      const r = await runPostHook(postHook, call.toolName, input, this.opts.cwd, output);
      if (r.appended) output += r.appended;
    }

    // Post-edit diagnostics: the project's check command runs after every
    // successful file change, and its failures are fed straight back — the
    // model fixes type/lint fallout now, not at the end of the task.
    if (this.opts.diagnosticsCmd && (call.toolName === "write" || call.toolName === "edit")) {
      const r = await runHook(this.opts.diagnosticsCmd, call.toolName, input, this.opts.cwd);
      if (r.code !== 0) {
        output +=
          `\n\n[diagnostics after this ${call.toolName}: \`${this.opts.diagnosticsCmd}\` exited ${r.code} — fix these before moving on]:\n` +
          r.output.trim().slice(0, 2000);
      }
    }
    return { output, isError: false };
  }

  /** Add synthetic tool results for any assistant tool calls with no matching result. */
  private patchDanglingToolCalls(newMessages: ModelMessage[]): void {
    const answered = new Set<string>();
    const called = new Map<string, string>();
    for (const m of this.messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === "object" && part !== null && "type" in part && part.type === "tool-call") {
            const p = part as { toolCallId: string; toolName: string };
            called.set(p.toolCallId, p.toolName);
          }
        }
      }
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === "object" && part !== null && "toolCallId" in part) {
            answered.add((part as { toolCallId: string }).toolCallId);
          }
        }
      }
    }
    const dangling = [...called].filter(([id]) => !answered.has(id));
    if (dangling.length === 0) return;
    const patch: ModelMessage = {
      role: "tool",
      content: dangling.map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: { type: "error-text" as const, value: "Cancelled by user." },
      })),
    };
    this.messages.push(patch);
    newMessages.push(patch);
  }
}
