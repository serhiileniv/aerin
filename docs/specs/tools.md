# Spec: Tool contract and cross-cutting rules

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/tools.md · Source: src/tools/types.ts (`ToolDef`, `ToolContext`, `truncateOutput`), src/tools/index.ts (`builtinTools`), src/core/agent.ts (`buildToolSet`, `dispatchToolCall`, `dispatchParallel`), src/permissions/policy.ts (`targetFor`, `ruleFor`), the built-ins in src/tools/*.ts · Tests: test/new-tools.test.ts, test/edit.test.ts, test/web-tools.test.ts, test/tool-progress.test.ts, test/background.test.ts, test/sanitize.test.ts, test/spill.test.ts, test/reliability.test.ts, test/schedule-tool.test.ts, test/agent-tool.test.ts, test/config.test.ts (`truncateOutput`)

## Goal

One small contract that every capability — built-in, MCP, bridge, sub-agent — implements, so the
agent loop can apply permissions, hooks, undo, progress rendering, output capping and transcript
summaries uniformly without knowing any tool's internals. "Done" means: a `ToolDef` declares its
schema, tier, summary, optional preview/tier-override, and an `execute` that returns a string or
throws; the loop does everything else in one fixed order.

## Non-goals

- This spec does not describe each built-in's internals (see docs/tools.md for the table and the
  per-feature docs for bash jobs, scheduling, memory, session search, sub-agents).
- Tools never execute inside the AI SDK: `buildToolSet` registers schemas only.
- No streaming tool output to the model; progress events are UI-only.
- No structured (non-string) tool results.

## Constraints

- **Flat schemas, primitive types only** (AGENTS.md): Google/OpenAI/Ollama choke on unions and
  `format`; `z.object` of strings/numbers/booleans with `.optional()`/`.describe()`, `z.enum` for
  small closed sets.
- Windows first-class: every spawn passes `windowsHide: true` and `shell: false`; commands never go
  through `cmd /c`; text matching normalises CRLF.
- No new deps; `ripgrep` is discovered, never bundled (its postinstall conflicts with the lean
  install rule).
- Line budget: all of `src/tools/` is 1,844 lines.
- Layering: `src/tools/` imports from core only `AgentEvent` types and `DATA_DIR`.

## Design

### The contract — `src/tools/types.ts`

```
interface ToolContext { cwd; abortSignal?; allowOutsideCwd; onProgress?(event: AgentEvent); toolCallId? }

interface ToolDef<S extends ZodTypeAny> {
  name: string; description: string; inputSchema: S;
  permission: "read" | "write" | "execute";
  tierFor?(input): PermissionTier;              // per-call override (schedule only today)
  summarize(input): string;                      // `Name(args)` one-liner
  preview?(input, ctx): Promise<string | undefined>;   // permission dialog detail (write/edit/memory)
  execute(input, ctx): Promise<string>;          // returns the model-visible result; throws on failure
}
```

`inputSchema` is zod for built-ins; MCP tools carry an AI-SDK `jsonSchema()` wrapper cast to
`ZodTypeAny` — the loop detects the missing `safeParse` and skips local validation.

### Registration

`builtinTools()` returns 13 defs in order: `read write edit ls glob grep bash bash_output websearch
webfetch todo memory schedule`. `setupAgent` then appends MCP tools (or the deferred bridge), the
`skill` tool (only when skills exist), `session_search` (needs the live session id), and after
construction `agent.registerTool(agent tool)` and, only when a frontend can answer, the `question`
tool. `Agent.buildToolSet()` maps each to `aiTool({ description, inputSchema })` — no `execute`, so
the SDK only ever emits `tool-call` parts.

### Dispatch order — `Agent.dispatchToolCall` (one call)

1. Deferred-bridge translation (`tool_call` → real tool; see deferred-mcp-tools.md).
2. Lookup in `toolsByName` then `deferredTools`; unknown → `Unknown tool: <name>` error result.
3. Zod `safeParse` when available; failure → `Invalid tool input: <message>` error result (the
   model self-corrects); parsed data replaces the raw input.
4. `summary = def.summarize(input)`; yield `tool-call { id, name, input, summary }`.
5. Doom-loop check: 4th byte-identical `(name, JSON input)` in this turn → synthetic permission ask.
6. `target = targetFor(name, input)` (`bash` → command; `agent` → agent/mode; `schedule` →
   `"<action> <name>"`; any string `path` → path; else `""`); `tier = def.tierFor?.(input) ?? def.permission`;
   `policy.decide(tier, target)`: `deny` → rule-named or plan-mode refusal.
7. Pre-hook (`pre:<name>` / `pre:*`): deny, allow, ask, or rewrite input (re-validated and re-checked
   against the policy; tier recomputed via `tierFor`).
8. `ask` → `preview = await def.preview?.(input, ctx).catch(() => undefined)`; `onPermission({ tool,
   input, summary, preview? })`; deny → `User denied permission…` result; allow-always → session rule
   `ruleFor(target)` (+ persisted to `.aerin/settings.json` for scope `project`).
9. Non-read tier → shadow-git `snapshotIfNeeded()`; without git, write-tier with a `path` →
   in-memory checkpoint.
10. Execute with the progress pump: `execute(input, { ...ctx, toolCallId, onProgress })` runs while
    queued events are yielded; `subagent-update` with status ≠ running folds `inputTokens`,
    `outputTokens`, `costUsd` into the agent totals.
11. Throw → `{ output: message, isError: true }` (rethrown if aborted).
12. Post-hook appends context; for `write`/`edit`, `diagnosticsCmd` failures append
    `[diagnostics after this <tool>: …]` (first 2000 chars).

`send()` then yields `tool-result { id, name, output, isError }` and stores
`{ type: "tool-result", toolCallId, toolName, output: { type: isError ? "error-text" : "text", value } }`.
Multiple `agent` calls in one step run concurrently via `dispatchParallel` (read-tier, so no dialogs
interleave); everything else is sequential. On abort, dangling calls get `Cancelled by user.` results.

### Output capping — `truncateOutput(text, { spillDir? })`

`MAX_OUTPUT_LINES = 2_000` (keep 75% head + 25% tail with `[... output truncated: N lines omitted ...]`),
then `MAX_OUTPUT_CHARS = 30_000` (70% head + 30% tail). When anything was cut and `spillDir !== false`,
the full text is written to `<DATA_DIR>/spill/tool-<base36 time>-<hex>.txt` (7-day sweep once per
process) and a pointer line is appended: `[full output (N chars) saved to <file> — grep it or read it
with offset/limit … delegate reading it to an agent]`. Spill failure degrades to plain truncation.
Every built-in that can return bulk output calls it (`read ls glob grep bash bash_output webfetch
schedule skill session_search`), as do MCP wrappers; `todo`, `memory`, `question`, `websearch`
(≤8 hits) return bounded text without it.

### Summaries, previews, progress

- `summarize` forms: `Read(path) Write(path) Update(path) List(path) Glob(pattern)
  Search("pattern" in glob) Bash(cmd≤80… &) JobOutput(job, kill) WebSearch("q") Fetch(url)
  Todo(n/m done) Memory(action: note) Schedule(action name …) Question(q≤70) Skill(name)
  SessionSearch(…) Agent(worker: name: description) Mcp(server.tool) ToolSearch/ToolDescribe/ToolCall(…)`.
  Used by permission prompts, the transcript, the doom-loop message, and replay via
  `Agent.summarizeCall` (which guards throws; the live dispatch call does not).
- `preview`: `write` → `(new file, N lines)` or a unified patch (`createTwoFilesPatch`, labels
  `before`/`after`); `edit` → patch of the applied edit or `(preview unavailable: …)`; `memory` →
  `+ note` / `- match` / `~ "match" → note`. Rendered by the TUI as `DiffText` and by the REPL with a
  `  | ` gutter.
- `onProgress` events: `tool-display` (edit/write diff, ≤24 lines, `Index:/===/---/+++` headers
  stripped — never sent to the model), `todo-update`, `subagent-update`.

### Guards shared by families of tools

- Paths: `assertInsideCwd` for `write`/`edit` (bypass: `--allow-outside-cwd`); `assertReadable` for
  `read ls glob grep` refuses credential-shaped paths (`.ssh .aws .gnupg .azure .kube .netrc .npmrc
  .git-credentials id_rsa* id_ed25519* credentials`) **outside** cwd.
- Web: `assertPublicHttpUrl` (http/https only; blocks localhost/.local/.internal, 127/10/0/172.16-31/
  192.168/169.254, `::1`/`::`/fc-fd/fe8-b) on the request and again on `res.url` after redirects;
  results wrapped in `[BEGIN untrusted web content …]…[END …]` / `[Untrusted search results …]`.
- Shell: `detectShell()` → `/bin/bash -lc` (or `/bin/sh`), Windows Git Bash, else PowerShell with a
  prompt warning; default timeout 120 s, max 600 s; `tree-kill` on timeout/abort; 200k capture
  buffer; background jobs are `unref()`'d, keep 400k, retain 20 finished.
- Search: ripgrep when found (PATH, VS Code bundles) else JS fallback with `assertSafePattern`
  (nested quantifiers rejected), 10 s deadline, 4000-char line cap, 5000-result cap; glob capped at
  200, `.gitignore` + `node_modules/.git/dist/build` ignored.
- Edit: `applyEdit` matches on LF-normalised text, requires exactly one match unless `replace_all`,
  restores the file's dominant EOL.

## Invariants

- Every tool result passes `truncateOutput` before reaching the model, and truncation keeps the tail —
  `test/config.test.ts` ("caps line count keeping head and tail"), `test/spill.test.ts` (spill file is
  byte-identical, `spillDir:false` disables, broken dir degrades); coverage of *every* tool calling it
  is untested.
- Progress events are yielded strictly between `tool-call` and `tool-result`, and sub-agent spend is
  folded into totals — `test/tool-progress.test.ts`.
- Several `agent` calls in one step run concurrently; other tools stay sequential —
  `test/tool-progress.test.ts` (concurrency); sequential half untested.
- `tierFor` picks the tier per call and `targetFor`/`ruleFor` give scoped rules —
  `test/schedule-tool.test.ts` ("looking is read-tier, changing is execute-tier", rules match on
  `<action> <name>`).
- Read-tier tools run without prompts; write/execute ask, deny beats all, plan mode denies non-read —
  `test/new-tools.test.ts` ("plan mode" block), `test/policy.test.ts`.
- `edit` matching is CRLF-agnostic and EOL-preserving; ambiguous matches are refused —
  `test/edit.test.ts`.
- `webfetch`/`websearch` are read-tier and SSRF-guarded — `test/web-tools.test.ts`.
- `todo` emits `todo-update`, coerces bad statuses to `pending`, is read-tier — `test/new-tools.test.ts`.
- `edit` emits a display-only `tool-display` diff — `test/reliability.test.ts`.
- `question` throws without an interactive user — `test/new-tools.test.ts`.
- Provider messages are JSON-clean before storage (`toPlainJson`) — `test/sanitize.test.ts`.
- Schemas are flat with primitive types — untested (no schema-shape test).
- Every spawn sets `windowsHide: true` and `shell: false` — untested.

## Acceptance criteria

1. A `ToolDef` with invalid input returns `Invalid tool input: …` as an error result rather than
   throwing out of the turn — **gap**.
2. `tool-call` carries `summarize(input)`; `tool-result` carries `isError` — test/tool-progress.test.ts,
   test/deferred-tools.test.ts.
3. Progress events land between call and result; `subagent-update` spend is folded —
   test/tool-progress.test.ts.
4. Parallel `agent` calls interleave; results are emitted in call order — test/tool-progress.test.ts.
5. `truncateOutput` line and char caps keep head and tail with a marker — test/config.test.ts.
6. Truncation spills the full text and appends the pointer; `spillDir:false` disables; failure
   degrades — test/spill.test.ts.
7. `tierFor` (schedule) makes list/inspect/log/doctor read and the rest execute; rules match
   `<action> <name>` — test/schedule-tool.test.ts.
8. `applyEdit` unique-match rule, `replace_all`, CRLF↔LF matching with EOL preservation —
   test/edit.test.ts.
9. `write`/`edit` refuse paths outside cwd unless `--allow-outside-cwd` — **gap**.
10. `read`/`ls`/`glob`/`grep` refuse credential-shaped paths outside cwd — **gap**.
11. `read` refuses binary files and numbers lines with offset/limit continuation — **gap**.
12. SSRF guard blocks internal targets pre- and post-redirect; web results are wrapped as untrusted —
    test/web-tools.test.ts (pre-redirect and wrapper presence only; post-redirect is a **gap**).
13. `bash` returns combined output plus `[exit code: N]`, kills on timeout/abort, supports
    `background:true` with `bash_output` incremental reads — test/reliability.test.ts ("background
    bash jobs"); foreground timeout/kill is a **gap**.
14. `grep` uses ripgrep when present and a guarded JS fallback otherwise — test/reliability.test.ts
    (`assertSafePattern` only); rg/fallback parity is a **gap**.
15. `todo` coerces statuses and emits `todo-update` — test/new-tools.test.ts.
16. `memory` creates/updates the `## Memory` section, dedupes, respects the budget —
    test/new-tools.test.ts (create/dedupe/insert), test/memory-bounded.test.ts (budget).
17. `question` returns `User answered: …` or throws without a user — test/new-tools.test.ts.
18. `edit`/`write` emit a `tool-display` diff capped at 24 lines — test/reliability.test.ts (emission);
    the cap is a **gap**.
19. `preview` output for write/edit/memory reaches the permission request — **gap**.
20. Pre-hook input rewrite is re-validated and re-checked against the policy —
    test/hooks-protocol.test.ts (not audited here; listed by AGENTS.md).
21. All schemas are flat objects of primitives/enums — **gap** (and `todo.items` is an array of
    objects, `question.options` an array of strings; see known gaps).
22. Every spawn uses `windowsHide`/`shell:false` — **gap**.

## Open questions / known gaps

- `todo` declares `items: array<{ text, status }>` and `question` `options: array<string>` — both
  exceed "primitive types only". They have worked across providers so far; no test guards the
  flatness rule for the rest.
- `test/background.test.ts` tests terminal background (OSC 11) detection, not background bash jobs;
  background jobs are covered in `test/reliability.test.ts`.
- `summarize` is called unguarded in dispatch: a throwing `summarize` would surface as a turn error.
- `assertReadable` only guards credential paths **outside** cwd; a repo containing
  `credentials.json` is readable by design.
- `bash` output is capped at 200k chars before truncation, silently.
- No test asserts that each tool calls `truncateOutput`; adding a tool that forgets it is caught only
  by review.
- `ls` has no `assertInsideCwd` and no path guard beyond `assertReadable` (read-tier, so acceptable).
- `edit.preview` applies the edit in memory a second time in `execute`; a file changing between
  preview and execute is not detected.

## Decisions

- 2026-07-22 (5c4aa1f, initial): tools return plain strings and throw on failure; the loop converts
  throws into `isError` results so the model can self-correct — simpler than a result type.
- 2026-07-22 (5c4aa1f): the AI SDK is given schemas only (`buildToolSet` without `execute`) so the
  permission gate always interposes.
- 2026-07-22 (9bde87e): head **and** tail truncation ("errors and summaries usually live at the end").
- 2026-07-22 (bd2e57b, v0.0.15): `background:true` + `bash_output` instead of a separate tool for
  servers/watchers; jobs deliberately outlive the session.
- 2026-07-22 (5c4aa1f, initial; extended in 7ede145, v0.0.27 "rg, guards"): ripgrep acceleration with
  a JS fallback, discovered rather than bundled (`@vscode/ripgrep`'s postinstall violates the
  lean-install rule); the ReDoS pattern guard and VS Code-bundled `rg` discovery came with v0.0.27.
- 2026-07-22 (388bf17, v0.0.46 "sub-agent-reviewed hardening"): SSRF guard (`assertPublicHttpUrl`)
  and credential-path guard (`SENSITIVE_RE`) added after a sub-agent security review; web content
  wrapped as untrusted data.
- 2026-07-22 (5c4aa1f, initial): CRLF-normalised `applyEdit` matching, named in AGENTS.md as the #1
  Windows edit failure.
- 2026-07-23 (88c0840, v0.0.105): spill files (opencode-style) so truncated output stays reachable
  without re-running commands.
- 2026-07-22 (5c4aa1f, initial): `preview` on the contract so write/edit diffs reach the permission
  dialog; 2026-07-22 (d0721d6, v0.0.7): `onProgress` added for sub-agent status, later reused for
  `tool-display` diffs and `todo-update` — tools never know about the UI.
- 2026-09-09 (2cb7467): `tierFor` added for the `schedule` tool, whose actions span read and execute;
  the static `permission` remains the fallback.
- 2026-09-09 (ab0a0db): `summarize` outputs standardised to `Name(args)` for the TUI's
  `● Name(args)` block grammar.
