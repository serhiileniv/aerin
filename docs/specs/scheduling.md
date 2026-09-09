# Spec: Scheduling — `schedule` tool, `/loop`, headless output formats

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/scheduling.md · Source: src/tools/schedule-tool.ts, src/core/loop.ts, src/core/session-commands.ts (`loopCommand` wrapper, `/loop` help entry), src/tui/App.tsx and src/modes/repl.ts (`/loop` dispatch), src/cli.ts (`--output-format`, `--prompt-file`), src/modes/print.ts (`createPrintFormatter`, `diagnostic`, `runPrint`), src/permissions/policy.ts (`targetFor`/`ruleFor` for `schedule`), src/tools/types.ts (`ToolDef.tierFor`), src/core/agent.ts (tier resolution), src/core/system-prompt.ts (scheduling guidance), src/modes/doctor.ts ("Scheduler" section) · Tests: test/schedule-tool.test.ts, test/loop.test.ts

## Goal

Three things shipped together on 2026-09-09 (2cb7467) without a spec. (1) When the user asks for anything recurring, the model schedules it through the user's own scheduler `every` (launchd / systemd user timers / Windows Task Scheduler, with run history) via one `schedule` tool — never crontab, plists, or timer units. (2) `/loop <when> <prompt>` schedules *aerin itself* as a headless run that outlives the session, replacing both cron lines and in-session polling loops, with one implementation for TUI and REPL. (3) `aerin -p` becomes a clean scriptable surface: `--output-format text|json`, `--prompt-file`, assistant text only on stdout, diagnostics on stderr, exit code 1 on error — which is what a loop's task runs.

## Non-goals

- In-session polling or timers (`/loop` never runs inside the process; `every` fires a fresh `aerin -p`).
- Cloud or remote scheduling; only the local machine's scheduler.
- Memory between loop firings. Each run is a new session; state travels through files or the prompt.
- A JSONL/streaming event format for print mode; `json` is one object at the end.
- Managing plain `schedule` tasks from `/loop` (only tasks whose command contains `--prompt-file` are loops).
- Installing `every`; the tool and `aerin doctor` print the installer line and stop.

## Constraints

- `src/` budget: schedule-tool.ts 179, loop.ts 255, print.ts 117 lines; fea36e0 rewrote them "tighter with the same tests" to get back under 10,000 (now 9,923).
- Layering: `/loop` logic in `core/loop.ts`; both frontends call `loopCommand` from `session-commands.ts` and print the returned string. Print mode is a frontend (`modes/print.ts`) that imports only core.
- Flat tool schema: `schedule`'s nine fields are string/boolean/number; `action` is a string validated at runtime against `SCHEDULE_ACTIONS`, not a zod enum.
- Windows first-class: `every` is spawned with `execFile` (argv, no shell, `windowsHide: true`); the binary lookup checks `every.exe` under `%LOCALAPPDATA%\every\bin`; `shellQuote` emits `"…"` with doubled quotes on win32 and `'…'` elsewhere; `resolveAerinInvocation` looks for `aerin.cmd`/`aerin.exe`. The tests that execute a fake `every` are `posixOnly` (the fake is a `#!/bin/sh` script).
- No new dependencies. `every` is an external binary the user installs (≥ 0.5.x: `set`, `inspect`, `run --dry-run`, `--json` are in its "for scripts and agents" help; its README does not list them).

## Design

### Part 1 — the `schedule` tool (src/tools/schedule-tool.ts)

Input `ScheduleInput`: `action` (required), `name?`, `when?`, `command?`, `timeout?`, `quiet?`, `on_fail?`, `lines?` (1–100), `dry_run?`.

`buildEveryArgs(input)` (pure) maps to `every` argv:

| action | argv | tier (`scheduleTier`) |
|---|---|---|
| `list` / `doctor` | `[action]` | read |
| `inspect` | `["inspect", name]` | read |
| `log` | `["log", name, "-n", N?]` | read |
| `add` | `["set", when, "--name", name, "--quiet"?, "--timeout", t?, "--on-fail", c?, "--", command]` | execute |
| `run` | `["run", name, "--dry-run"?]` | execute |
| `pause` / `resume` | `[action, name]` | execute |
| `remove` | `["rm", name]` | execute |

Validation throws: unknown action (`Unknown action "<x>". Use one of: …`), missing name for anything but list/doctor, `add` without `when` or `command`. `add` uses `set`, so re-adding a name updates in place. The command is **one** argv token after `--`; `every` runs it through the user's login shell, so pipes, `&&`, globs work and nothing strips quotes.

Binary lookup `findEvery()`: `AERIN_EVERY_BIN` env → `~/.local/bin/every[.exe]` → (win32) `%LOCALAPPDATA%\every\bin\every.exe` | (posix) `/opt/homebrew/bin/every`, `/usr/local/bin/every` → bare `every` on PATH. First hit is cached (`resetEveryCache()` is the test seam).

`runEvery(args, { cwd, timeoutMs?, signal? })` → `{ output, code }`: `execFile` with `maxBuffer` 4 MB; stdout and stderr joined. `ENOENT` rejects with the install hint (`EVERY_INSTALL_HINT`, platform-specific) and "Do not fall back to crontab, launchd, or systemd timers."; a killed (timed-out) child rejects with `every <verb> timed out after <ms>ms`. Timeouts: 30 s default, 10 min for a real `run`.

`describeExit` maps `every`'s sysexits: 66 → `No such task[ or no runs logged yet]`; 64 → `every rejected the arguments`; otherwise `[every <action> failed with exit code N]`, or for `run` just `[exit code N]` (the command's own code). Success output falls back to `(nothing scheduled)` / `every … : ok`; `add` appends `(Runs from <cwd>. Check it with action "run" or "inspect"; history with "log".)`. Everything passes through `truncateOutput`.

Permissions: `permission: "execute"` is the static fallback (what sub-agent toolsets would see — the tool is in neither); `tierFor: scheduleTier` decides per call in `agent.ts` (`def.tierFor?.(input) ?? def.permission`, re-evaluated after a pre-hook rewrites the input). `targetFor("schedule", input)` = `"<action> <name>"`, so rules read `schedule(add *)`, `deny: schedule(remove backup*)`. `ruleFor` turns an "always" approval into `schedule(<action> *)` — the action, not one task name.

The system prompt tells the model to route anything recurring through `schedule`, never to write cron/plist/timer units or suggest cron, and describes recurring *agent* work as a headless run. `aerin doctor` prints `every <version>: on PATH|<path>` or a warning with the installer line.

### Part 2 — `/loop` (src/core/loop.ts)

`parseLoopArgs(arg) → LoopRequest`:
- `""` | `list` | `ls` → `{kind:"list"}`; `log <name> [n]`; `run <name>`; `stop|rm|remove <name>` → `stop`. Missing name throws `/loop <verb> needs a loop name`.
- Otherwise options `--name <v>`, `--timeout <v>`, `--yolo` are taken before the schedule and again right after it; past the prompt start they are plain words. `--` splits schedule from prompt explicitly.
- Without `--`, `scheduleLength(tokens)` decides how many leading tokens are `every`'s phrase, per head word: durations (`\d+[smhd]`), `hourly|daily|weekly` → 1; `day|weekdays|weekends|<day list>` → head + time (+ separate `am|pm`); `monthly` → optional ordinal list + time; `once` → duration, or optional `today|tomorrow|<day>|YYYY-MM-DD` + time. 0 → `"<tok>" is not a schedule…`.
- Result: `{ kind:"add", when, prompt, name?, timeout: "10m" default, yolo }`. Empty prompt throws `needs a prompt`.

Naming: `loopNameFor(prompt)` = `loop-` + kebab-cased opening words, ≤ 24 chars on a word boundary (`loop` if nothing survives). Auto-names skip names `every list --json` already has (`-2`, `-3`, …); an explicit `--name` is used as-is (and `set` updates in place).

The scheduled command (`buildLoopCommand`): `<aerin…> -p --output-format text --prompt-file <file> [--yolo] [-m <modelId>]`, each element `shellQuote`d (bare if `^[A-Za-z0-9_@%+=:,./-]+$`). `<aerin…>` from `resolveAerinInvocation()`: bare `aerin` when some PATH dir has `aerin` (`aerin.cmd`/`.exe` on win32) and the running entry is not `index.ts`; otherwise `[process.execPath, process.argv[1]]` pins the current runtime + entry (dev checkouts, npx caches, GUI PATH).

`loopCommand(ctx: LoopCtx, arg)`, `LoopCtx = { cwd, yolo, modelId?, loopsDir?, aerin? }` (last two are test seams; `session-commands.ts` fills `yolo` from `policy.autoApprove` and `modelId` from the live agent):
- `add`: pick name → `mkdir -p <DATA_DIR>/loops` → write `<name>.md` = prompt + `\n` → `every set <when> --name <name> --timeout <t> -- <command>` (cwd = session cwd). Non-zero exit → delete the prompt file, return output + `(every rejected the loop — check the schedule phrase)` + `LOOP_USAGE`. Success → a 4–5 line receipt: `loop <name>: every <when> → aerin -p [--yolo ]"<prompt≤60>"`, `runs from <cwd>, timeout <t>, tools auto-approved (--yolo)` | `tools limited to read-tier and allow rules (add --yolo to let it edit/run)`, the fresh-session warning, the three management commands, and `every`'s first output line.
- `list`: `every list --json` (JSON located from the first `[`), filtered to `command.includes("--prompt-file")`; rows `name  schedule  status|paused  last <time>[ (exit N)]|never ran · next <time>` plus the prompt file's first 70 chars; empty → `(no loops — …)`.
- `log`: `every log <name> [-n N]`; 66 → `no loop "<name>" (or it has not run yet)`.
- `run`: `every run <name>` with a 15 min timeout; non-zero → `[exit code N]`.
- `stop`: `every rm <name>`, then delete the prompt file; `stopped <name> (run history kept: every log <name>)`.

Frontends: TUI `case "/loop"` and REPL `/loop` both `await loopCommand(setup, arg)` and print the string; a thrown usage error is printed the same way. `/help` lists `/loop` from `SLASH_COMMANDS`.

### Part 3 — headless output (src/cli.ts, src/modes/print.ts)

CLI: `--output-format <format>` (default `text`; validated against `OUTPUT_FORMATS = ["text","json"]` before anything else — bad value → `aerin: --output-format must be one of text, json (got "x")` on stderr, exit 1). `--prompt-file <path>`: file read, trimmed, appended after the argument prompt with a blank line. Piped stdin (non-TTY) is then appended as `[piped stdin]:`. `-p` with no prompt from any source → error, exit 1.

`runPrint(flags, prompt)`: permissions auto-deny (`Non-interactive mode; re-run with --yolo to allow tools.`) unless `--yolo`; warnings → stderr; unresolvable model → stderr + exit 1; no `question` tool is registered (no `onQuestion`). Events go through `createPrintFormatter(format, out, err)`; `finish({ sessionId, model })` returns `isError` → `process.exitCode = 1`; `teardown()` runs the `session:end` hook and stops MCP servers.

`createPrintFormatter`:
- `text`: every `text-delta` is written as it arrives; `message-end` writes `\n` only if the last delta did not end with one (`lineOpen`); `finish()` closes an unterminated final message the same way. Nothing else touches stdout.
- `json`: deltas buffer per message; `finish()` writes one line: `{"result": messages.join("\n\n") (trailing newlines stripped per message), "isError", "error"? (joined error messages), "sessionId", "model", "toolCalls", "usage": {inputTokens, outputTokens, costUsd?}}`.
- Both: `diagnostic(e)` lines on stderr — `[tool] <summary>`, `[tool error] <200 chars>`, `[retry a/b] …`, `[failover] from -> to: …`, `[goal complete|continues N] …`, `[agent done|error] …`, `error: <message>`. The REPL reuses `diagnostic()` for its default branch.

### Data flow of one loop firing

```
/loop 15m check CI ──▶ loops/loop-check-ci.md ──▶ every set 15m --name loop-check-ci --timeout 10m -- 'aerin -p --output-format text --prompt-file … -m …'
                                                          │ (launchd/systemd/Task Scheduler, login shell, cwd = session cwd)
                                                          ▼
                              aerin -p … ──▶ stdout: assistant text · stderr: [tool]/[retry]/error · exit 0|1 ──▶ every log / every list (ok|FAIL)
```

## Invariants

- `add` maps to idempotent `set` and passes the command as one token after `--` — test/schedule-tool.test.ts "add uses idempotent `set`…"; end-to-end argv and cwd — "add spawns every with argv (no shell) in the tool's cwd".
- Every action maps to the documented `every` verb — "read/manage actions map to every's verbs".
- Unknown actions and missing fields are rejected before anything is spawned — "rejects unknown actions and missing required fields".
- `list/inspect/log/doctor` are read-tier, everything else execute; the static `permission` is `execute` — "looking is read-tier, changing is execute-tier".
- Rules match `<action> <name>`; "always" saves `schedule(<action> *)`; deny beats allow — "rules match on '<action> <name>'…".
- `schedule` is a registered built-in — "is registered as a built-in tool"; it is in neither sub-agent toolset — test/agent-tool.test.ts exact-set tests.
- `AERIN_EVERY_BIN` overrides discovery — "AERIN_EVERY_BIN overrides discovery".
- Exit 66 is explained as a missing task; a failing `run` reports the command's exit code — the two exit-code tests.
- A missing binary explains the installer and forbids cron — "a missing binary explains how to install every and forbids cron".
- Tests never touch the real scheduler (`AERIN_EVERY_BIN` → fake script) — both suites' `fakeEvery`.
- The schedule grammar is split off per head word and a bare duration never swallows a numeric prompt — test/loop.test.ts "splits every's schedule grammar…" and "a bare duration never swallows…"; `--` separates explicitly — "`--` separates…".
- Options are parsed only before the prompt — "options before the prompt: --name, --timeout, --yolo".
- Usage errors name the problem — "usage errors name the problem".
- Names derive from the prompt, ≤ 24 chars, and never clobber an existing task — "loop names come from the prompt's opening words", "auto-names skip names every already has".
- `shellQuote` is platform-aware — "shellQuote is platform-aware…"; invocation prefers bare `aerin`, pins runtime+entry otherwise, dev checkouts always pinned — "prefers bare `aerin` on PATH…".
- The scheduled command is always `aerin -p --output-format text --prompt-file …` — "the scheduled command is a headless text run…" and "add writes the prompt file and schedules `every set`…".
- `--yolo` on the loop or the session → `--yolo` on the run — "--yolo (or a --yolo session)…".
- A rejected `set` leaves no orphan prompt file — "a rejected schedule removes the prompt file and explains".
- `/loop` lists only prompt-file tasks — "list shows only loops…"; `stop` removes task and file — "stop removes the task and its prompt file…"; `log`/`run` pass through — "log and run pass through to every".
- Text output: one newline per message, never doubled, diagnostics on stderr, unterminated final message closed — the two "text:" tests.
- JSON output: exactly one object with the documented keys; `isError` and exit status track error events — "json: one object on stdout…".
- `--output-format` validation and `--prompt-file` assembly in cli.ts — **untested**.
- `runPrint` exit code 1 on error / on unresolvable model — **untested**.
- `aerin doctor` reports `every` — **untested**.
- The Windows execution path (`every.exe` lookup, `execFile` on win32) — **untested** in CI (posixOnly fakes).

## Acceptance criteria

1. Asking for a recurring task produces a `schedule(add …)` call, never a crontab/plist edit. — prompt text only; **gap** (no test asserts the system-prompt line).
2. `add` → `every set <when> --name <n> [--quiet] [--timeout] [--on-fail] -- <cmd>` with the command as one token. — schedule-tool.test.ts (two tests).
3. `list/inspect/log/doctor` run in plan mode and without prompts; `add/run/pause/resume/remove` prompt as execute. — "looking is read-tier…" (tier) and "rules match…" (policy decisions); plan-mode denial of execute actions specifically is a **gap**.
4. `schedule(add *)` / `schedule(remove backup*)` rules work; "always" saves the action-wide rule. — "rules match on…".
5. Exit 66/64/other are explained; `run` reports the command's own code. — the exit-code tests (64 is a **gap**).
6. Missing `every` → installer hint + "do not fall back to crontab". — "a missing binary explains…".
7. `every` runs from the session cwd via argv, no shell. — "add spawns every with argv…".
8. `/loop <when> <prompt>` splits every's grammar for all documented phrases; `--` overrides. — loop.test.ts parse tests.
9. `--name/--timeout/--yolo` are honored before the prompt; default timeout 10m. — "options before the prompt…" and the add test.
10. The prompt is stored at `<data>/loops/<name>.md` and the task runs `aerin -p --output-format text --prompt-file <file> [--yolo] -m <model>`. — "add writes the prompt file…".
11. Auto-names avoid collisions; explicit names update in place. — "auto-names skip…" (explicit-name update is a **gap**).
12. `every set` failure → no prompt file, explanation + usage. — "a rejected schedule…".
13. `/loop` lists only loops with status, last/next, exit code and prompt; `/loop log|run|stop` manage; unknown names explained. — the four management tests.
14. Both frontends dispatch `/loop` to the same implementation and print errors instead of crashing. — **gap** (no TUI/REPL test).
15. `aerin -p` text mode: stdout is assistant text only, one newline per message. — "text: streams…" and "text: an unterminated…".
16. `aerin -p --output-format json`: one JSON object with result/isError/error/sessionId/model/toolCalls/usage. — "json: one object…".
17. Diagnostics (`[tool]`, `[retry]`, `error:` …) go to stderr in both formats. — same tests (`[tool]` and `error:` covered; retry/failover/goal/agent lines are **gaps**).
18. Exit code 1 when the run errored; `--output-format` rejected values exit 1. — **gap**.
19. `--prompt-file` content is appended after the argument prompt; piped stdin after that. — **gap**.
20. `aerin doctor` shows the `every` version or the install line. — **gap**.
21. Loops inherit `-m <session model>`. — "add writes the prompt file…" (`-m mock/m`).

## Open questions / known gaps

- Two paths for "recurring agent work" disagree: the system prompt tells the model to schedule `aerin -p --output-format text --yolo "<prompt>"` inline (shell-quoted prompt, always `--yolo`), while `/loop` writes a prompt file and only adds `--yolo` when asked. docs/scheduling.md's invariant ("never the prompt text inline") holds for `/loop` only. Should the model-driven path use `--prompt-file` too, or should the prompt point the model at `/loop`'s convention?
- `/loop` list treats any `every` task whose command contains `--prompt-file` as a loop — including ones the user made by hand with the `schedule` tool.
- `/loop stop` on an explicitly named task that was not created by `/loop` removes it (no marker distinguishes them).
- `when()` in the list output uses `toLocaleString([], …)`; output varies by locale and is untested.
- `every list --json` field shapes (`last.at/exit`, `next`, `paused`, `status`) are assumed from the fake in tests, not verified against a real `every` version; `every schema` exists and could pin this.
- The scheduled run uses the session's model but not its other flags (`--allow-outside-cwd`, `--no-mcp`, `--cwd`); the task's cwd is the session cwd, which is the only one that carries over.
- Windows: all `every`-executing tests are skipped; the `LOCALAPPDATA` lookup and `.exe` path are unverified in CI.
- No test drives `main()`'s flag handling (`--output-format` validation, `--prompt-file` read, stdin merge).
- Print mode registers no `question` tool but the system prompt still says "ask ONE clarifying question with the question tool"; a headless run may try and get an unknown-tool error.
- `costUsd` in the JSON `usage` is omitted (not `null`) when no pricing is known; consumers must treat it as optional.

## Decisions

- 2026-09-09 (2cb7467): `every` over cron everywhere — run history, missed-run catch-up, login-shell PATH, cwd, failure notifications, and Apple's deprecation of cron (README "vs cron"). The system prompt forbids cron outright and the tool's ENOENT message repeats it so the model cannot rationalize a fallback.
- 2026-09-09: one tool with an `action` field plus `ToolDef.tierFor` (new in this commit) rather than nine tools or a single execute-tier tool — read actions must work in plan mode and without prompts; rules match `<action> <name>` so users can pin tasks.
- 2026-09-09: `every set` over `every <when>` so re-adding updates in place; command passed as a single argv token after `--` so `every`, not aerin, does the shell interpretation (no quoting bugs on Windows).
- 2026-09-09: `/loop` schedules a *headless aerin* through `every` rather than an in-process timer — survives the session, has a run history, and reuses the scheduler already trusted for user tasks. One implementation in `core/loop.ts`, per the frontend-consolidation rule.
- 2026-09-09: the prompt lives in a file read via the new `--prompt-file` flag, not inline, to avoid shell quoting of user text on any platform and to keep multi-line prompts.
- 2026-09-09: default `--timeout 10m` on loops so a hung run cannot block the next one (every's own README warns the OS will not start a second copy).
- 2026-09-09: bare `aerin` when on PATH (readable in `every list`), otherwise pin `process.execPath + argv[1]`; `index.ts` always pins so a dev checkout does not run a globally installed release.
- 2026-09-09: print mode's stdout is assistant text (or one JSON object) and nothing else; `json` is one object, not JSONL, because the consumer is a shell script or `every log`. The REPL reuses `diagnostic()` to stay under the line budget (fea36e0).
- 2026-09-09: binary discovery checks `~/.local/bin` and Homebrew before PATH because GUI-launched terminals often lack `~/.local/bin`.
