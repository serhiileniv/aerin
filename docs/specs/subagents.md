# Spec: Sub-agents (`agent` tool)

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/subagents.md · Source: src/tools/agent-tool.ts, src/core/agents.ts, src/core/system-prompt.ts (`buildSubagentSystemPrompt`, `buildWorkerSystemPrompt`, the "Named sub-agents" section and the delegation guidance), src/permissions/policy.ts (`targetFor` for `agent`), src/core/agent.ts (`ensureShadow`, the progress pump in `dispatchToolCall`), src/cli.ts (registration), src/core/events.ts (`subagent-update`) · Tests: test/agent-tool.test.ts, test/tool-progress.test.ts, test/policy.test.ts ("deny rules can block spawning workers or specific named agents")

## Goal

Let the main agent delegate work to a nested agent with its own context window so the parent conversation stays small: a research sub-agent explores and returns only a text report (the files it reads never enter the parent context); a worker sub-agent additionally edits files and runs commands for a self-contained task. "Done" means: delegation is one flat tool call, several sub-agents in one turn run in parallel, their spend shows in the parent's meter, workers obey the user's live permission rules with asks surfacing one at a time, worker edits are covered by `/undo`, and no sub-agent can ever spawn another.

## Non-goals

- Sharing conversation context with the sub-agent. Isolation is deliberate (Hermes-style): the prompt is the sub-agent's entire world.
- Multi-level agent trees. Spawn depth is exactly one; neither toolset contains `agent`.
- Giving sub-agents `schedule`, `todo`, `memory`, `skill`, `question`, `session_search`, or MCP tools. They get the fixed lists below.
- Streaming the sub-agent's text to the user. Only counts and the last tool are shown while it runs; only the final message is returned.
- Loading AGENTS.md into sub-agent prompts (kept lean on purpose; see `buildSubagentSystemPrompt`'s comment).

## Constraints

- `src/` budget (10,000 lines): agent-tool.ts is 234 lines, agents.ts 71, the two prompt builders ~40.
- Layering: everything lives in `tools/` and `core/`; the TUI only renders `subagent-update` and the REPL/print reuse `diagnostic()` from print.ts.
- Flat tool schema: `description`, `prompt`, `agent?`, `mode?` are all plain strings — `mode` is `z.string()` compared to `"worker"`, not an enum, because unions break some providers.
- Windows: `agents.ts` frontmatter parsing accepts `\r\n`; no spawning happens here (bash inside a worker goes through the normal bash tool).
- Provider quirks: the sub-agent model is resolved lazily per call so a bad `subagentModel` surfaces as a tool error, not a startup crash (cli.ts comment).

## Design

### Toolsets (src/tools/agent-tool.ts)

```
subagentTools() = [read, ls, glob, grep, websearch, webfetch]          // all read-tier
workerTools()   = [...subagentTools(), write, edit, bash]
```

Neither list contains `agent` — the recursion guard. Constants: `SUBAGENT_MAX_ITERATIONS = 15`, `WORKER_MAX_ITERATIONS = 30`, `SUBAGENT_TOKEN_BUDGET = 500_000` (cumulative in+out tokens; exceeding it aborts the sub-agent but keeps any report text).

### Dependencies (`AgentToolDeps`, wired in src/cli.ts `setupAgent`)

| Dep | Source in cli.ts | Purpose |
|---|---|---|
| `getModel` | `() => ({ model: agent.model, modelId: agent.modelId })` | live view so `/model` switches carry over |
| `getSubagentModel?` | only when `config.subagentModel` | cheaper model for all sub-agents |
| `namedAgents?` | `discoverAgents(cwd)` | `agent:"name"` lookup |
| `resolveModelFn?` | `resolveModel(id, config)` | named agent `model:` override |
| `policy` | the parent's `PermissionPolicy` | workers inherit rules, mode, session approvals |
| `onPermission` | the parent's prompt | worker asks reach the real user |
| `getShadow` | `() => agent.ensureShadow()` | worker writes land in the parent turn's snapshot |
| `diagnosticsCmd?` | resolved once at setup | workers get post-edit diagnostics too |

The tool is registered with `agent.registerTool(...)` after the `Agent` is constructed so the resolvers can close over the live agent.

### Tool definition

- `name: "agent"`, `permission: "read"` — the *spawn* is read-tier (allowed in plan mode); what a worker then does is gated per call by the parent's policy, so in plan mode a worker's writes are denied like the parent's would be.
- `summarize` → `Agent(<desc>)`, `Agent(worker: <desc>)`, `Agent(<name>: <desc>)`, `Agent(worker: <name>: <desc>)`.
- Permission target (`targetFor` in policy.ts): `agent` → `input.agent ?? input.mode ?? ""`, so `deny: ["agent(worker)"]` blocks all workers and `deny: ["agent(deploy-*)"]` blocks named agents by pattern while plain research stays allowed.

### `execute(input, ctx)` — as built

1. `input.agent` set but not found → throw `Unknown named agent: <x>. Available: <names|none>`.
2. Model: `deps.getSubagentModel?.() ?? deps.getModel()`; then a named agent's `model` overrides via `resolveModelFn`.
3. `id = ctx.toolCallId ?? "subagent-<counter>"`; `isWorker = input.mode === "worker" || named?.mode === "worker"`.
4. System prompt: `buildWorkerSystemPrompt(cwd)` or `buildSubagentSystemPrompt(cwd)`; for a named agent, `"<named.systemPrompt>\n\n<basePrompt>"` — the custom prompt leads, the standard rules always apply underneath.
5. `new Agent({...})` with:
   - `tools`: `workerTools()` or `subagentTools()`;
   - `policy`: the parent's when `isWorker && deps.policy`, else a fresh `new PermissionPolicy([], false)`;
   - `onPermission`: workers → `askSerialized({...req, summary: "Agent(<desc>) › <req.summary>"})`; researchers → always `{ kind: "deny", reason: "Sub-agents cannot request permissions." }` (an invariant backstop: read-tier tools never ask, so this is only reached if the invariant breaks);
   - `maxIterations`: 30 / 15; `getShadow` and `diagnosticsCmd` passed only to workers.
6. `askSerialized` chains every worker ask through one `permissionLock` promise so parallel workers never open two dialogs at once (the TUI holds a single pending request); without `deps.onPermission` it denies with "No interactive user to grant permissions."
7. Abort propagation: `ctx.abortSignal` → `sub.abort()`, listener removed in `finally`.
8. Event consumption from `sub.send(input.prompt)`:
   - `text-delta` → `textBuf`; `message-end` → `finalText = textBuf` (the last *completed* message is the report; earlier narration is discarded);
   - `tool-call` → `toolCalls++`, `lastTool = summary`, progress `running`;
   - `usage` → accumulate tokens/cost, progress `running`; over `SUBAGENT_TOKEN_BUDGET` → `sub.abort()` once;
   - `error` → remember `errorMsg`.
9. After the stream: a partial buffer with no `message-end` still counts as the report. Then, in order: parent aborted → progress `error`, throw `Interrupted.`; `errorMsg && !finalText` → progress `error`, throw `Sub-agent exceeded its token budget before producing a report.` or `Sub-agent failed: <msg>`; otherwise progress `done` and return `truncateOutput(finalText || "(sub-agent produced no report)")`.

Note the asymmetry: an `error` event *with* report text is swallowed and the report returned.

### Progress and accounting (src/core/agent.ts)

`ctx.onProgress` emits `{ type: "subagent-update", id, description, status: "running"|"done"|"error", lastTool?, toolCalls, inputTokens, outputTokens, costUsd }`. The parent's `dispatchToolCall` pump yields these between the `tool-call` and `tool-result` events and, for non-`running` updates, adds the tokens and cost to `totalInputTokens`/`totalOutputTokens`/`totalCostUsd` — one place, so every frontend's meter is truthful. Independent `agent` calls in one assistant message run concurrently (the tool loop dispatches tool calls in parallel).

### Undo coverage

The sub-`Agent.ensureShadow()` returns `opts.getShadow()` when provided, so a worker's `snapshotIfNeeded()` before write/execute tools snapshots the **parent's** shadow index — no second `ShadowGit` on the same index (a race, per the code comment), and `/undo` in the parent reverts worker edits.

### Named agents (src/core/agents.ts)

- Discovery order, earlier roots win on name collision: `<cwd>/.aerin/agents/*.md`, `<cwd>/.claude/agents/*.md`, `<GLOBAL_CONFIG_DIR>/agents/*.md`. Result sorted by name.
- Frontmatter (`---` block, `key: value` lines, surrounding quotes stripped): `name` (default: filename without `.md`), `description` (default `(no description)`), `model` (optional `provider/id`), `mode: worker` (anything else = research). Body = `systemPrompt`; files with an empty body are skipped.
- Listed in the main system prompt under "Named sub-agents (pass agent:"name" to the agent tool when their specialty matches)".

### Prompts (src/core/system-prompt.ts)

- Researcher: read-only tools, work autonomously, never ask, only the final message is returned, report with absolute paths / line numbers / verbatim snippets, no preamble; cwd/platform/date.
- Worker: same isolation contract plus: can read/edit/write/bash, cannot spawn agents, no drive-by changes, verify when possible, do not work around permission denials, final message must list every changed file and verification output.
- Parent guidance: delegate broad searches to `agent`; delegate self-contained implementation with `mode:"worker"` and a complete prompt; issue independent agent calls together.

### Rendering

- TUI: while running, a panel of up to 4 `agent · <desc> · <n> tools · <lastTool|starting>` lines (`+N more agents` beyond that); on finish a `child()` line `agent done|error · <desc> · <n> tools · <tok> tok · <cost>`; the stats line re-reads the parent totals.
- REPL/print: `[agent done|error] <desc> (<n> tools, <tok> tok)` via `diagnostic()`; running updates are silent.

## Invariants

- `subagentTools()` is exactly `{glob, grep, ls, read, webfetch, websearch}` and every one is read-tier — test/agent-tool.test.ts "is exactly the read-only set…" and "every sub-agent tool is read-tier".
- `workerTools()` is the research set plus `{write, edit, bash}` and still no `agent` — "adds write/edit/bash to the research set but still no agent tool".
- The `agent` tool is read-tier with a flat schema requiring `description` and `prompt` — "is read-tier and validates its flat schema".
- Only the final report is returned and exactly one non-running `subagent-update` is emitted, carrying the parent `toolCallId` and the cumulative usage — "runs a sub-agent and returns its report, emitting one final update".
- `getSubagentModel` wins over `getModel` — "uses the subagent model override when provided".
- Worker writes pass through the parent's `onPermission` with the `Agent(<desc>) › ` label — "worker mode writes files through the parent's permission gate, with a labeled ask".
- A denied worker action leaves the file untouched and the worker still reports — "worker mode respects a user denial and reports instead of writing".
- A research sub-agent cannot write even when its model tries — "research mode has no write tool even if the model tries to call it".
- `mode: worker` frontmatter opts a named agent into the worker toolset — "named agents opt into worker mode via frontmatter".
- An error with no report throws `Sub-agent failed: …` — "throws when the sub-agent errors without producing a report".
- Progress events are yielded between `tool-call` and `tool-result` and finished sub-agent spend is folded into the parent totals — test/tool-progress.test.ts "progress events are yielded…".
- Several `agent` calls in one turn overlap in time — test/tool-progress.test.ts "multiple agent tool calls in one turn run concurrently".
- `agent(worker)` / `agent(deploy-*)` deny rules block spawns while plain research is unaffected — test/policy.test.ts "deny rules can block spawning workers…".
- Parallel worker asks are serialized through `permissionLock` — **untested**.
- The token budget aborts a runaway sub-agent and keeps its partial report — **untested**.
- Worker edits land in the parent's shadow snapshot (`getShadow` passthrough) — **untested** (tests stub `getShadow: async () => null`).
- Discovery precedence `.aerin` > `.claude` > global — **untested**.
- Named prompt composition `"<custom>\n\n<base>"` and the `model:` override — **untested**.
- Parent abort → `sub.abort()` → `Interrupted.` — **untested**.

## Acceptance criteria

1. Research sub-agents have only read-tier tools and no `agent` tool. — agent-tool.test.ts (two `subagentTools` tests).
2. Workers add exactly `write`, `edit`, `bash`; still no `agent`. — "adds write/edit/bash…".
3. The tool call returns the sub-agent's final message only, truncated by `truncateOutput`. — "runs a sub-agent and returns its report…" (truncation itself is a **gap**).
4. One terminal `subagent-update` per call with `id === toolCallId`, `status`, `description`, token totals. — same test.
5. `config.subagentModel` routes sub-agents to that model. — "uses the subagent model override…".
6. Worker asks go through the parent's `onPermission`, labeled with the task, and a deny is honored. — the two worker tests.
7. The parent's policy (rules, mode, session approvals) governs worker actions. — **gap**: tests use a fresh empty policy; no test with a deny rule or plan mode on the parent policy reaching the worker.
8. Worker asks from parallel workers are serialized. — **gap**.
9. Sub-agent spend is folded into the parent meter. — tool-progress.test.ts.
10. Independent `agent` calls run in parallel. — tool-progress.test.ts.
11. `deny: ["agent(worker)"]` disables workers; `agent(<name>)` patterns block named agents. — policy.test.ts.
12. Named agents are discovered from the three roots with the documented precedence and frontmatter. — "named agents opt into worker mode via frontmatter" covers `.aerin/agents` and `mode`; precedence, `model`, quoted values and CRLF are **gaps**.
13. Unknown `agent:` name errors with the available list. — **gap**.
14. `/undo` reverts worker edits. — **gap**.
15. Exceeding 500k tokens aborts the sub-agent and returns the partial report (or the budget error if none). — **gap**.
16. Esc/abort in the parent interrupts running sub-agents. — **gap**.
17. Workers run post-edit diagnostics when the parent has a command. — **gap** (wiring only; see docs/specs/diagnostics.md).
18. TUI/REPL render running and finished sub-agent lines as specified. — **gap** (test/tui-system.test.tsx covers the glyph set, not these lines).

## Open questions / known gaps

- An `error` event followed by (or preceded by) any report text is swallowed: the parent gets the report and never learns the sub-agent hit an error. Probably acceptable for research; questionable for workers that errored mid-edit.
- The `agent` tool is read-tier, so a plan-mode parent can spawn a worker; the worker's writes are then denied one by one with the plan-mode message, burning iterations. Not a safety hole, but wasteful.
- `subagentModel` applies to workers too, so a cheap research model may be doing edits; there is no separate `workerModel`.
- Headless (`aerin -p` without `--yolo`) workers get every write denied by the print-mode `onPermission`; the system prompt does not tell the model this.
- `SUBAGENT_TOKEN_BUDGET` is cumulative in+out across iterations, which for a 15-iteration researcher is dominated by repeated input tokens; whether 500k is the right number has not been revisited since v0.0.7.
- Worker prompts skip AGENTS.md entirely (both builders do), so project conventions must be restated in the delegation prompt. docs/subagents.md says so; whether workers should get the memory section is open.
- No test exercises `getShadow` passthrough or `diagnosticsCmd` inside a worker.

## Decisions

- 2026-07-22 (d0721d6, v0.0.7): first `agent` tool — read-only researcher with its own context window, 15-iteration and 500k-token caps, `subagent-update` progress events and `ToolContext.onProgress` plumbing, spend folded into the parent meter, `subagentModel` config.
- 2026-07-22 (64e9462, v0.0.57): named agents in the Claude Code file layout (`.claude/agents` read for compatibility, `.aerin/agents` first, global last), frontmatter `name/description/model`, body as system prompt, standard rules "always apply underneath".
- 2026-07-23 (53d1c3a, v0.0.97): worker mode. Chosen: reuse the parent's `PermissionPolicy` object rather than copy its rules (session approvals and mode changes stay live); serialize asks through a promise lock rather than a queue UI (the TUI has one pending-request slot); pass the parent's shadow-git instead of creating a second one (two `ShadowGit`s on one index race); spawn depth of one, Hermes-style; `WORKER_MAX_ITERATIONS = 30` because workers must edit and verify.
- 2026-07-23 (f038545, v0.0.99): workers receive `diagnosticsCmd` so unattended edits self-correct the same way the parent's do.
- 2026-09-09 (ab0a0db, TUI polish): sub-agent lines moved to the `⎿` child glyph and ` · ` grammar; the REPL reuses print.ts `diagnostic()` instead of its own strings (fea36e0, line-budget consolidation).
