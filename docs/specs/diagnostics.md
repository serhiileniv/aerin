# Spec: Post-edit diagnostics

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/diagnostics.md · Source: src/core/diagnostics.ts, src/core/agent.ts (`dispatchToolCall`, after the post-hook), src/cli.ts (`setupAgent` resolution and wiring), src/core/hooks.ts (`runHook`, the shared runner), src/config/config.ts (`diagnostics` key), src/tools/agent-tool.ts (`diagnosticsCmd` passthrough to workers) · Tests: test/diagnostics.test.ts

## Goal

After every successful `write` or `edit`, run the project's check command and hand its failures straight back to the model in the same tool result, so type and lint fallout is repaired in the next iteration rather than discovered at the end of the task — opencode's LSP-diagnostics idea without an LSP. "Done" means: a passing check adds nothing; a failing check appends a clearly delimited block to the tool result without turning the successful edit into an error; the command comes from config or, conservatively, from a `typecheck` script in package.json; and it never runs twice when the user already wired the same check as a post-hook.

## Non-goals

- A language server or per-file diagnostics. The whole project check runs, and its text is fed back verbatim.
- Detecting anything beyond the `typecheck` script convention (no `lint`, `check`, `tsc` guessing).
- Running after `bash`-driven edits (`sed`, `git apply`, code generators) or after MCP tools. Only the built-in `write` and `edit` tool names trigger it.
- Blocking or reverting the edit. The check is advisory; the edit stays applied.
- Deduplicating runs across several edits in one assistant message (see known gaps).

## Constraints

- `src/` budget: `diagnostics.ts` is 68 lines; the agent-side hook is ~10 lines; execution reuses `runHook` from `hooks.ts` rather than adding a spawn path.
- Layering: resolution in `core/diagnostics.ts`, wiring in `cli.ts`, execution inside `core/agent.ts` — no frontend involvement; frontends see only a longer tool result.
- Windows: `runHook` spawns through `detectShell()` with `windowsHide: true` and `shell: false`; the command is a shell line interpreted by the detected shell, never a `cmd /c` string built by hand.
- No new dependencies.
- Latency is paid on every edit; the header comment and docs both say to point `diagnostics` at a fast command or `false` if it hurts.

## Design

### Resolution (src/core/diagnostics.ts)

```
resolveDiagnosticsCommand(cwd, { configured, hooks }) → string | undefined
  configured === false                     → undefined (off, including auto-detection)
  configured is a non-blank string         → configured (always, hooks or not)
  hooks has post:write | post:edit | post:* → undefined (hooks stay the single mechanism)
  otherwise                                → detectDiagnosticsCommand(cwd)

detectDiagnosticsCommand(cwd) → string | undefined
  read <cwd>/package.json; missing/unparsable → undefined
  scripts.typecheck not a string            → undefined
  package manager by lockfile: bun.lock | bun.lockb → bun; pnpm-lock.yaml → pnpm; yarn.lock → yarn; else npm
  → "<pm> run typecheck"
```

`DiagnosticsOpts = { configured: string | false | undefined; hooks?: Record<string, string> }`. Config schema (config.ts): `diagnostics: z.union([z.string(), z.literal(false)]).optional()`; the project file's value overrides the global one when either is defined.

### Wiring (src/cli.ts `setupAgent`)

Resolved once per process, after the `session:start` hook and before the `Agent` is constructed:

```
const diagnosticsCmd = await resolveDiagnosticsCommand(cwd, { configured: config.diagnostics, hooks: config.hooks });
new Agent({ ..., ...(diagnosticsCmd ? { diagnosticsCmd } : {}) });
createAgentTool({ ..., ...(diagnosticsCmd ? { diagnosticsCmd } : {}) });   // workers inherit it
```

`AgentOptions.diagnosticsCmd?: string`. The agent-tool passes it to worker sub-agents only (`isWorker && deps.diagnosticsCmd`); researchers cannot edit, so they never need it. Changing `aerin.json` mid-session does not re-resolve.

### Execution (src/core/agent.ts `dispatchToolCall`)

Order at the tail of a successful tool call:

1. The tool's `execute` returned without throwing (`isError: false`).
2. Post-hook (`hookFor(hooks, "post", toolName)`) runs and may append.
3. Diagnostics: `if (opts.diagnosticsCmd && (call.toolName === "write" || call.toolName === "edit"))`
   - `r = await runHook(diagnosticsCmd, call.toolName, input, cwd)`
   - `r.code !== 0` → append
     ```
     \n\n[diagnostics after this <write|edit>: `<cmd>` exited <code> — fix these before moving on]:\n<r.output.trim().slice(0, 2000)>
     ```
   - `r.code === 0` → nothing.
4. Return `{ output, isError: false }` — the edit's success is never overridden.

`call.toolName` here is the real tool name (deferred MCP bridge calls are remapped earlier), so only the built-in `write`/`edit` match. A tool error path returns before step 3, so a failed edit never triggers a check.

### The runner (src/core/hooks.ts `runHook`)

Shared with pre/post hooks: spawns `detectShell().path` with `shell.args(command)`, `cwd`, env `AERIN_TOOL=<toolName>` and `AERIN_TOOL_INPUT=<JSON, ≤8,000 chars>`, writes `{ tool, input, cwd }` JSON (≤32,000 chars) to stdin and closes it. stdout+stderr are captured up to `MAX_HOOK_OUTPUT = 4_000` chars. `HOOK_TIMEOUT_MS = 60_000` → kill, `{ code: 124, output: "...\n[hook timed out after 60s]" }`; spawn failure → `{ code: 127 }`. The diagnostics block then truncates that output again to 2,000 chars.

### Data flow

```
write/edit ok ──▶ post-hook? ──▶ diagnosticsCmd? ──runHook──▶ code≠0 ──▶ output += "[diagnostics after this edit: …]"
                                                  └──────────▶ code=0 ──▶ output unchanged
```

The model sees the block as part of the `write`/`edit` result on its next iteration; the TUI/REPL show it inside the collapsed tool result like any other output.

### Configuration matrix (as resolved by `resolveDiagnosticsCommand`)

| `diagnostics` in config | `post:write`/`post:edit`/`post:*` hook | package.json `typecheck` | Command that runs |
|---|---|---|---|
| `"cargo check"` | any | any | `cargo check` (and the hook, if any, also runs) |
| `false` | any | any | nothing |
| unset | present | any | nothing from diagnostics (the hook is the mechanism) |
| unset | absent | present, `bun.lock` | `bun run typecheck` |
| unset | absent | present, `pnpm-lock.yaml` | `pnpm run typecheck` |
| unset | absent | present, `yarn.lock` | `yarn run typecheck` |
| unset | absent | present, no lockfile | `npm run typecheck` |
| unset | absent | absent | nothing |

Lockfile precedence when several exist: bun, then pnpm, then yarn, then npm (the `detectDiagnosticsCommand` ternary order).

### Worked example (from the "a failing check is appended" test)

Config `diagnosticsCmd` = `node -e "console.error('DIAGFAIL: a.txt broke types');process.exit(3)"`; the model calls `write { path: "a.txt", content: "x" }`. The tool result the model receives is the write tool's normal success text followed by:

```

[diagnostics after this write: `node -e "…"` exited 3 — fix these before moving on]:
DIAGFAIL: a.txt broke types
```

`a.txt` contains `x`, the `tool-result` event has `isError: false`, and the TUI shows the block under the `● Write(a.txt)` rail as ordinary result output. With `process.exit(0)` the result contains no `[diagnostics` text at all.

### Relationship to hooks

Diagnostics and post-hooks share the runner and the "append to the tool result" contract but differ in scope and protocol:

| | Post-hook (`post:edit` etc.) | Diagnostics |
|---|---|---|
| Trigger | any tool the pattern matches, success or failure of the hook is what appends | `write`/`edit` success only |
| Output on success | JSON `{"context": …}` may append (≤1,500 chars) | nothing |
| Output on failure | `[post-hook "<tool>" failed (exit N)]:` + ≤1,500 chars | `[diagnostics after this <tool>: …]:` + ≤2,000 chars |
| Configured by | `hooks` map | `diagnostics` string, or auto-detected |
| Ordering | runs first | runs second, sees the same `input`, not the hook's appended text |

## Invariants

- The `typecheck` script is the only auto-detected convention and the package manager follows the lockfile (bun/pnpm/yarn/npm) — test/diagnostics.test.ts "finds the typecheck script and picks the lockfile's package manager".
- No package.json or no `typecheck` script → no auto command — "returns undefined without a typecheck script or package.json".
- An explicit command always wins; `false` disables everything; unset auto-detects — "explicit command wins, false disables everything".
- Auto-detection yields to `post:write`/`post:edit`/`post:*` hooks, but an explicit command runs alongside hooks — "auto-detection steps aside when a post hook is already wired".
- A failing check appends `[diagnostics after this write …]`, the exit code and the captured output, while `isError` stays `false` and the file is written — "a failing check is appended to the write tool's result".
- A passing check appends nothing — "a passing check appends nothing".
- Runs for `edit` exactly as for `write` — **untested** (only `write` is exercised).
- Only `write`/`edit` trigger it; `bash` and MCP tools do not — **untested**.
- Output truncation (4,000 in the runner, 2,000 in the block) and the 60 s timeout — **untested**.
- Workers receive the same command — **untested** (wiring only).
- Runs after the post-hook, never before it — **untested**.
- A failed edit (`isError: true`) never runs the check — **untested**.

## Acceptance criteria

1. `"diagnostics": "<cmd>"` runs `<cmd>` after every successful write/edit regardless of hooks. — resolution: test/diagnostics.test.ts "explicit command wins…" and "…steps aside…" (second assertion); execution: "a failing check is appended…".
2. `"diagnostics": false` disables the feature including auto-detection. — "explicit command wins, false disables everything".
3. Unset + package.json `typecheck` → `<pm> run typecheck` with the lockfile's manager. — "finds the typecheck script…" (`bun.lock` covered; `bun.lockb` is a **gap**).
4. Unset + a `post:write`/`post:edit`/`post:*` hook → nothing auto-runs. — "auto-detection steps aside…" (`post:edit` covered; `post:write` and `post:*` on the auto path are **gaps**).
5. Failure output is appended in the documented format, with the exit code, and the tool result is still a success. — "a failing check is appended…".
6. A passing check leaves the result untouched. — "a passing check appends nothing".
7. The check runs after `edit` as well as `write`. — **gap**.
8. The check does not run after `bash` or any other tool. — **gap**.
9. A hung check is killed after 60 s and reported as exit 124 with the timeout note. — **gap** (the runner's timeout is untested for any hook).
10. Appended output is capped at 2,000 chars. — **gap**.
11. Worker sub-agents run the same command after their edits. — **gap**.
12. The check runs in the project `cwd` with `AERIN_TOOL`/`AERIN_TOOL_INPUT` in the environment. — **gap** (cwd is implied by the failing-check test writing `a.txt`, env is unchecked).

## Open questions / known gaps

- Several edits in one assistant message each run the full check serially — N edits, N typechecks — and each sees the intermediate state. A per-iteration debounce ("run once after the last edit of this batch") would cut latency but is not built.
- The check is one command for the whole project; on a monorepo edit in a sub-package it runs from the aerin `cwd`, not the package. No per-path scoping.
- `diagnostics` is resolved once at startup; `/model`, `/resume` and config edits during the session do not re-resolve, and there is no `/diagnostics` command or `/status` line showing what is active.
- The block says "fix these before moving on" even when the failure is pre-existing and unrelated to the edit (no baseline comparison), which can send the model off to fix someone else's type error.
- Exit code 124 (timeout) is reported like any failure; the model gets "[hook timed out after 60s]" with no hint to change `diagnostics`.
- `edit` and worker paths are untested; the `write` test is the only end-to-end coverage.

## Decisions

- 2026-07-22 (64e9462, v0.0.57): hooks shipped with `post:edit: "bun run typecheck"` as the documented recipe; a real LSP client was "deliberately NOT included (hooks cover the post-edit diagnostics recipe)".
- 2026-07-23 (f038545, v0.0.99): the recipe became automatic. Chosen: auto-detect only the `typecheck` script (conservative, per the header comment) over guessing `lint`/`tsc`; run via the lockfile's package manager rather than `npx tsc`; make hooks the single mechanism when present so the same check never runs twice; keep the edit's success (`isError: false`) so the model repairs fallout instead of retrying the edit.
- 2026-07-23: reuse `runHook` (60 s timeout, bounded output, `windowsHide`) rather than a second spawn path — one runner to keep Windows-safe, and fewer lines under the budget.
- 2026-07-23: pass the same command to worker sub-agents (agent-tool.ts `diagnosticsCmd`), on the grounds that unattended edits need the feedback most.
- 2026-07-23: cap the appended block at 2,000 chars, on top of the runner's 4,000, so one failing check cannot flood the context.
