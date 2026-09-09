# Spec: Hooks

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/hooks.md · Source: src/core/hooks.ts, src/core/agent.ts (`dispatchToolCall` pre/post, `send()` prompt:submit and turn:end, `compactNow` compact:pre), src/cli.ts (session:start in `setupAgent`, session:end in `teardown`), src/modes/repl.ts, src/modes/print.ts, src/tui/run.tsx (all call `teardown`), src/core/diagnostics.ts (steps aside for post hooks), src/tools/bash.ts (`detectShell`) · Tests: test/hooks-protocol.test.ts, test/lifecycle-hooks.test.ts, test/highvalue.test.ts ("hooks"), test/diagnostics.test.ts

## Goal

Let a project run its own shell commands around the agent's actions — before and after each tool call,
and at session/prompt/turn/compaction boundaries — with enough power to enforce policy (block, force a
prompt, rewrite arguments), feed results back to the model (typecheck output, reminders), and add
context (freeze notices, environment facts). "Done" means: a one-line config entry wires a script; the
script gets the full call as JSON; it can decide with a JSON object or, for the simplest case, an exit
code; and no hook can weaken the permission deny list.

## Non-goals

- A plugin API or in-process hooks. Hooks are child processes speaking stdin/stdout.
- Matching on anything but tool name (no per-path or per-argument hook selection; the script filters).
- Replacing post-edit diagnostics: `core/diagnostics.ts` is the default typecheck-after-edit path and
  yields to a user-wired `post:write`/`post:edit`/`post:*` hook.
- Running lifecycle hooks in worker sub-agents. `AgentOptions.hooks` is only set for the main agent in
  `cli.ts`; sub-agents are constructed in `agent-tool.ts` without `hooks`, so neither tool hooks nor
  `prompt:submit`/`turn:end` fire inside them.

## Constraints

- `src/` line budget: `hooks.ts` is 192 lines; call sites add ~60 in `agent.ts` and ~15 in `cli.ts`.
- Windows first-class: commands run through `detectShell()` — `/bin/bash -lc` (or `/bin/sh`), Git Bash
  `-lc` when found under Program Files, else `powershell.exe -NoProfile -NonInteractive -Command`.
  `windowsHide: true`, `shell: false`. Hook authors on PowerShell cannot use `&&`.
- Layering: core only; hooks never emit UI. The one visible artifact is a `tool-display` event for a
  `turn:end` block.
- No new deps: `node:child_process.spawn`.

## Design

### Config

`config.hooks: Record<string, string>` (merged global + project in `loadConfig`). Keys:
`pre:<tool>`, `post:<tool>`, `pre:*`, `post:*`, and the five lifecycle names. `hookFor(hooks, phase,
tool)` returns `hooks["<phase>:<tool>"] ?? hooks["<phase>:*"]` — specific beats wildcard, no chaining.

### Process contract (`runHook(command, toolName, input, cwd, extra?)`)

- Env: `process.env` + `AERIN_TOOL=<toolName>` + `AERIN_TOOL_INPUT=<JSON(input).slice(0, 8000)>`.
- Stdin: `JSON.stringify({ tool, input, cwd, ...extra }).slice(0, 32_000)`, then end. Stdin errors are
  swallowed so a command that never reads stdin cannot crash aerin.
- Stdout and stderr are concatenated into `output`; appending stops once `output.length >= 4_000`
  (`MAX_HOOK_OUTPUT`; a chunk may overshoot).
- Timeout `HOOK_TIMEOUT_MS = 60_000` → kill, `{ code: 124, output: output + "\n[hook timed out after
  60s]" }`. Spawn failure → `{ code: 127, output: "hook failed to start: <msg>" }`. Exit → `{ code:
  code ?? 1, output }`.

### Protocol selection (`parseHookJson(output)`)

Trim; try the whole text as JSON; if that fails and there are ≥2 non-empty lines, try the last line.
Only a non-null, non-array object counts. Anything else → `undefined` → legacy protocol.

### Tool hooks in `dispatchToolCall`

Order: bridge remap → validation → `tool-call` event → doom-loop check → `policy.decide` (deny returns
here, **before** any hook) → **pre-hook** → permission ask → undo snapshot → `execute` → (tool error
returns here) → **post-hook** → diagnostics → result.

Pre (`runPreHook`), stdin `extra = { phase: "pre" }`:

| Hook output | `PreHookResult` | Agent effect |
|---|---|---|
| JSON `{"decision":"deny","reason"}` | `deny` | `Blocked by pre-hook: <reason ?? "(no reason given)">`, error result |
| JSON `{"decision":"allow"}` | `allow` | `policyDecision = "allow"` — skips the prompt |
| JSON `{"decision":"ask"}` | `ask` | `policyDecision = "ask"` — forces a prompt even under rules/`--yolo` |
| JSON with `"input": {…}` | `replacedInput` | input re-validated by zod (built-ins; MCP passthrough skips), `tier` recomputed via `tierFor`, `policy.decide` re-run; deny → `The pre-hook's rewritten input is blocked by a permission deny rule.`; validation failure → `Pre-hook rewrote the input but it failed validation: …` |
| JSON without a recognized decision | `none` | no change (the rewrite, if any, still applies) |
| non-JSON, exit ≠ 0 | `deny` | reason `pre-hook exited <code>: <output[:800] or "(no output)">` |
| non-JSON, exit 0 | `none` | no change |

The decision override happens after the rewrite re-check, so `{"decision":"allow","input":{…}}` allows
the rewritten call only if the policy does not deny it.

Post (`runPostHook`), stdin `extra = { phase: "post", output: toolOutput.slice(0, 8_000) }`, runs only
when `execute` resolved (not on tool errors):

| Hook output | Appended to the tool result |
|---|---|
| JSON with non-empty `context` | `\n[post-hook "<tool>"]:\n<context[:1500]>` |
| JSON without `context` | nothing, whatever the exit code |
| non-JSON, exit ≠ 0 | `\n[post-hook "<tool>" failed (exit <code>)]:\n<output[:1500]>` |
| non-JSON, exit 0 | nothing |

### Lifecycle hooks (`runLifecycleHook(hooks, event, payload, cwd)`)

Returns `undefined` when the key is absent; `{}` for non-JSON output; else
`{ context?: string[:2000], blockReason?: string }` where `blockReason` is set for `decision` `"block"`
**or** `"deny"` (`reason` trimmed, default `blocked by hook`). Exit codes are ignored. The child runs via
`runHook(cmd, event, payload, cwd, { event })`, so as built the stdin payload is
`{"tool":"<event>","input":<payload>,"cwd":…,"event":"<event>"}` — the event payload sits under `input`,
and `AERIN_TOOL` is the event name.

| Key | Call site | Payload (`input`) | Effect |
|---|---|---|---|
| `session:start` | `cli.ts:177-186`, after tools/session setup, before `new Agent` | `{ sessionId, model, resumed }` | `context` → `systemPrompt += "\n\nContext from the session:start hook:\n" + context` |
| `prompt:submit` | `agent.ts:445-452`, first thing in `send()` | `{ prompt }` | `blockReason` → yields `{ type:"error", message:"Prompt blocked by prompt:submit hook: …" }` and returns before the message is stored; `context` → `input += "\n\n[context from prompt:submit hook]\n" + context` |
| `turn:end` | `agent.ts:647-666`, when a response has no tool calls, after the goal-loop branch, while `turnEndBlocks < 3` | `{ response: turnText.slice(-4000) }` | `blockReason` (and not aborted) → `turnEndBlocks++`, yields `tool-display` `(turn:end hook: <reason> — continuing)`, pushes user message `[turn:end hook] Your turn was rejected: <reason>\nAddress this before finishing.`, resets `iteration = -1`, continues |
| `compact:pre` | `agent.ts:373-381`, `compactNow()` (auto and `/compact`) | `{ preTokens, messages }` | observational |
| `session:end` | `cli.ts:391-395`, `teardown()` | `{ sessionId, messages }` | observational; then MCP servers stop |

`teardown` is called from the REPL, print mode, and the TUI (`tui/run.tsx:139`). `turn:end` does not run
when the goal loop continues, when the turn ends in an error/abort, or when the iteration cap is hit.
The three-block cap is per `send()`.

### Diagnostics interplay

`resolveDiagnosticsCommand` returns `undefined` (auto-detection off) when `post:write`, `post:edit` or
`post:*` is configured; an explicit `diagnostics` command still runs regardless
(`diagnostics.ts:63-67`).

## Invariants

- Pre-hooks run before the permission prompt and can skip it — test/hooks-protocol.test.ts
  `{"decision":"allow"} skips the permission prompt entirely`.
- A pre-hook deny blocks before the tool runs and its reason reaches the model —
  test/hooks-protocol.test.ts `{"decision":"deny"} blocks before the tool runs`.
- Rewritten input is re-validated and used — test/hooks-protocol.test.ts "input rewriting redirects the
  write and is re-validated".
- Deny rules beat hooks: a rewrite into a denied path is blocked — test/hooks-protocol.test.ts "a rewrite
  cannot route around a permission deny rule".
- Post-hook `context` is appended on exit 0; empty JSON appends nothing even on exit 1; legacy non-zero
  appends output — test/hooks-protocol.test.ts "runPostHook" (two tests), "post-hook {"context"} lands
  in the tool result on exit 0".
- Legacy pre: non-zero exit denies with the output as reason, zero is a no-op — test/hooks-protocol.test.ts
  "legacy: non-zero exit denies".
- JSON wins over the exit code — test/hooks-protocol.test.ts "JSON: decision and reason are honored,
  exit code ignored".
- `parseHookJson` accepts whole stdout or last line, rejects arrays/plain text/empty —
  test/hooks-protocol.test.ts "parseHookJson".
- Specific hook keys beat wildcards; `runHook` reports exit code and output — test/highvalue.test.ts
  "hookFor resolves specific over wildcard; runHook reports exit and output".
- `prompt:submit` block stops the turn before the model is called and stores nothing —
  test/lifecycle-hooks.test.ts "prompt:submit block vetoes the prompt".
- `prompt:submit` context rides with the user message — test/lifecycle-hooks.test.ts.
- `turn:end` block forces continuation, capped at 3 per turn, with no error —
  test/lifecycle-hooks.test.ts "turn:end block sends the agent back to work, capped at 3 rounds".
- `runLifecycleHook` returns `undefined`/`{}`/parsed verdicts as specified — test/lifecycle-hooks.test.ts
  "runLifecycleHook" (two tests).
- Auto-diagnostics step aside for post hooks — test/diagnostics.test.ts "auto-detection steps aside when
  a post hook is already wired".
- A deny-rule call never runs its pre-hook (deny is checked first) — untested.
- `{"decision":"ask"}` forces a prompt under `--yolo` or an allow rule — untested.
- Post-hooks do not run when the tool errored — untested.
- Timeout (124) and spawn failure (127) codes — untested.
- Output cap (4 000) and payload caps (8 000 env, 32 000 stdin) — untested.
- `session:start`, `compact:pre`, `session:end` call sites — untested (only `runLifecycleHook` itself).
- Hooks run under PowerShell when no bash is found on Windows — untested.

## Acceptance criteria

1. `pre:<tool>` / `post:<tool>` / wildcards resolve with specific-over-wildcard precedence —
   test/highvalue.test.ts.
2. Every hook receives `AERIN_TOOL`, `AERIN_TOOL_INPUT` and the JSON stdin payload — **gap** (no test reads
   the env or stdin from inside a hook; `runHook` tests only check exit/output).
3. Legacy pre-hook: non-zero exit blocks with output as the error — test/hooks-protocol.test.ts (unit);
   through the agent loop: **gap**.
4. Legacy post-hook: non-zero output is appended — test/hooks-protocol.test.ts (unit).
5. JSON pre `allow` skips the prompt — test/hooks-protocol.test.ts.
6. JSON pre `deny` blocks with reason — test/hooks-protocol.test.ts.
7. JSON pre `ask` forces a prompt where rules/`--yolo` would allow — **gap**.
8. JSON pre `input` rewrites, is re-validated against the schema, and re-checked against the policy —
   test/hooks-protocol.test.ts (two tests). Schema-failure message: **gap**.
9. JSON post `context` is appended on any exit code — test/hooks-protocol.test.ts.
10. Permission deny rules beat every hook decision — test/hooks-protocol.test.ts (rewrite case); the
    "deny returns before the pre-hook runs" ordering: **gap**.
11. `session:start` context joins the system prompt — **gap**.
12. `prompt:submit` block vetoes; context enriches — test/lifecycle-hooks.test.ts.
13. `turn:end` block sends the agent back, max 3× — test/lifecycle-hooks.test.ts.
14. `compact:pre` and `session:end` fire with their payloads — **gap**.
15. Hooks time out after 60 s and cannot hang the turn — **gap**.
16. Non-JSON lifecycle output is ignored — test/lifecycle-hooks.test.ts (returns `{}`).
17. Auto-diagnostics step aside when a post hook exists — test/diagnostics.test.ts.
18. Sub-agents run no hooks — **gap** (documented here from `agent-tool.ts` construction; untested).

## Open questions / known gaps

- `docs/hooks.md` says lifecycle hooks "receive their payload on stdin"; as built the payload is nested
  under `input` next to `tool`, `cwd`, `event`. Scripts that expect `{"sessionId":…}` at top level break.
  Decide whether to flatten (breaking) or fix the doc.
- The 32 000-char stdin slice can cut a JSON object mid-string; the env var slice at 8 000 likewise. A
  hook parsing either gets a JSON error with no signal that truncation happened. Big `write` inputs are
  the realistic trigger.
- `MAX_HOOK_OUTPUT` is checked before appending, so output can exceed 4 000 by one chunk. The cap counts
  stdout and stderr together: a hook that logs more than ~4 000 chars of progress before printing its
  JSON verdict never gets the verdict line appended, and silently degrades to the legacy protocol. Not
  observed in practice; worth a note in the docs.
- Post-hooks are skipped when the tool throws; a post-hook that wants to observe failures cannot.
- Timeout kills with `child.kill()` (SIGTERM); a hook that spawned its own children may leave them
  running.
- `runHook` merges stdout and stderr, so a script that logs progress to stderr must still print the JSON
  verdict last (the last-line rule handles this) — documented implicitly only.
- `turn:end` is skipped on goal-loop continuations, so a stop-gate hook and `/goal` do not compose: the
  hook only sees the final judged-done turn.
- Lifecycle `decision: "deny"` is accepted as a block for every event, including observational ones
  where it does nothing; harmless.
- No hook runs inside worker sub-agents even though they write and run commands under the parent's
  policy. Likely an oversight rather than a decision; nothing in git history mentions it.
- Acceptance items 2, 3 (loop path), 7, 8 (message), 10 (ordering), 11, 14, 15, 18 are untested.

## Decisions

- 2026-07-22 (64e9462, v0.0.57): tool hooks from config keyed `pre:<tool>`/`post:<tool>` with `*`
  wildcards; exit-code protocol (pre non-zero blocks with output as the error; post non-zero appends);
  `AERIN_TOOL`/`AERIN_TOOL_INPUT` env; 60 s timeout. Chosen as "the practical LSP-diagnostics substitute"
  — a real LSP client was deliberately not built.
- 2026-07-23 (d5084d4, v0.0.102): JSON protocol layered on top, selected by what the hook prints (whole
  stdout or last line), exit code ignored when JSON is present: pre `allow`/`deny`/`ask` + `input`
  rewrite, post `context`. Pre-hooks moved to run **before** the permission prompt (Claude Code's
  ordering) so they are a policy point; deny rules stay above hooks and rewritten input is re-validated
  and re-decided so a hook cannot redirect a write into a denied path.
- 2026-07-23 (40887ec, v0.0.111): five lifecycle events on the same config map and JSON protocol —
  `session:start` (context → system prompt), `prompt:submit` (veto/enrich), `turn:end` (block → keep
  working, hard cap 3 per turn so an always-blocking hook cannot trap the turn), `compact:pre`,
  `session:end`. Non-JSON output is ignored for lifecycle events (observational by default), unlike tool
  hooks where exit codes still matter. `parseHookJson` extracted to share between the two.
- 2026-07-23 (f038545, v0.0.99, `core/diagnostics.ts`): post-edit typecheck auto-detection yields to a
  user-wired post hook so nothing runs twice; hooks stay the single mechanism when present.
- 2026-09-09 (fea36e0): `teardown()` in `cli.ts` became the one exit path for all three frontends, so
  `session:end` fires from the TUI, REPL and print mode alike.
