# Aerin — agent instructions

## Knowledge base
Feature docs live in `docs/` — **`docs/index.md` is the index**. Read the relevant page before changing a subsystem (each page states the invariants that must hold and names the source files); update the page in the same commit when behavior changes.

## Architecture (orientation)
- The agent loop is `Agent.send()` in `src/core/agent.ts` — an async generator of `AgentEvent`s (src/core/events.ts), consumed by three frontends: Ink TUI (`src/tui/`), plain REPL (`src/modes/repl.ts`), headless print (`src/modes/print.ts`).
- Permission tiers read/write/execute in `src/permissions/policy.ts`; deny rules beat allow/accept/--yolo (bash denies match chained-command segments); plan mode denies write/execute outright; chained bash commands always ask.
- Sub-agents (`tools/agent-tool.ts`): read-only researchers by default; `mode:"worker"` grants write/edit/bash under the PARENT's policy + onPermission (serialized asks) + shared shadow-git (`AgentOptions.getShadow`); workers can never spawn agents.
- Scheduling (`tools/schedule-tool.ts`): the `schedule` tool drives `every` (launchd/systemd/Task Scheduler with run history) — aerin never uses cron, and the system prompt says so. `ToolDef.tierFor` makes list/log/inspect/doctor read-tier and add/run/pause/resume/remove execute-tier; rules match `schedule(<action> <name>)`. `/loop <when> <prompt>` (`core/loop.ts`, one impl for TUI + REPL) schedules a headless `aerin -p --output-format text --prompt-file <data>/loops/<name>.md` run via `every set`; print mode (`modes/print.ts`) keeps stdout to assistant text or one JSON object (`--output-format json`), diagnostics on stderr.
- Post-edit diagnostics (`core/diagnostics.ts`): config `diagnostics` command (or auto-detected `typecheck` script) runs after write/edit; failures append to the tool result; auto-detection steps aside when post:write/post:edit/post:* hooks exist.
- Spill files (`tools/types.ts` truncateOutput): truncated outputs save the FULL text to DATA_DIR/spill with a grep/read-slices hint appended; 7-day sweep once per process; `spillDir: false` in opts (tests) disables.
- Doom-loop breaker (`agent.ts` dispatchToolCall): 4th byte-identical call of one tool in a turn → synthetic permission ask (any tier/mode); allow-always whitelists the tool for the session; deny returns change-your-approach guidance. Per-turn tracking, post-deferred-remap so real MCP names are compared.
- Goal loop (`core/goal-judge.ts` + the finished-turn branch in `agent.ts`): `/goal <text>` arms `Agent.startGoal`; each finished turn is judged (fail-open, evidence-required), not-done pushes a continuation user message with a fresh tool-iteration budget; bounded by `maxGoalTurns` (20); judge prefers `getJudgeModel` (subagentModel). Lives in send() so all frontends get it.
- Hooks (`core/hooks.ts`): dual protocol — legacy exit codes, or JSON stdout (pre: decision allow/deny/ask + input rewrite; post: context injection). Pre-hooks run BEFORE the permission prompt; deny rules beat hooks, and rewritten input is re-checked against the policy. Lifecycle events on the same map: session:start (context→system prompt, cli.ts), prompt:submit (veto/enrich, agent.ts), turn:end (block→keep working, 3× cap), compact:pre, session:end (frontends' teardown).
- Provider failover (`agent.ts`): config `fallbackModels` -> AgentOptions.fallbacks (lazy resolvers); on retryable-exhausted or quota/billing errors the send loop walks the chain (`advanceFailover`), emits a "failover" event, and activeModel/activeModelId drive streamText, caching, family guidance, cost, and compaction; reset per turn and on setModel.
- Deferred MCP tools (`core/deferred-tools.ts`): schemas >10% of context (or `deferMcpTools: true`) hide behind tool_search/tool_describe/tool_call bridges; agent.ts translates tool_call into the REAL tool before permissions, so rules/hooks/undo see the actual name while transcript pairing stays on the bridge call.
- Cross-cutting core: undo/redo via shadow-git snapshots (`core/shadow-git.ts`; in-memory fallback `core/checkpoints.ts` when git is missing), compaction — token-budgeted tail + iteratively-updated structured summary (`core/compact.ts`) — and stale tool-output pruning (`pruneOldToolResults`), @mentions (`core/mentions.ts`), skills (`core/skills.ts`), custom commands (`core/commands.ts`).
- Providers: built-ins + any OpenAI-compatible baseURL (`providers/registry.ts`); model pricing/context from models.dev (`providers/modelsdev.ts`) — dynamic data wins over the static table.

- Runtime: developed with Bun, but **write Node-compatible code only** — no `Bun.*` APIs (`bun run check:no-bun-globals` enforces this). Use `node:fs/promises`, `node:child_process`, etc.
- Markdown rendering (`terminal/markdown.ts`, shared by TUI and REPL): marked + marked-terminal, reflowed at the current width. Tables are NOT marked-terminal's — `terminal/table.ts` fits columns to the width and word-wraps cells (content-sized tables shear their borders when the terminal wraps them); every rendered line must stay ≤ the width passed in.
- Layering rule: nothing outside `src/tui/` may import from `src/tui/`, and nothing in `src/core|tools|providers|permissions|config|session|mcp` may import `ink` or `react`. The core <-> UI contract is `AgentEvent` in `src/core/events.ts`.
- Tool schemas stay flat with primitive types only — Google/OpenAI/Ollama all have JSON Schema quirks; unions and `format` break providers.
- Windows is a first-class target: normalize CRLF before string matching (see `applyEdit`), spawn with `windowsHide: true`, never build `cmd /c` command strings.
- Tests: `bun test`. Typecheck: `bun run typecheck`. Build: `bun run build` (shebang must stay the first line of `dist/index.js`).
- Keep dependencies lean — `npx aerin` cold-start matters. No packages with native postinstall steps.

## Memory
- test suite runs with bun test
