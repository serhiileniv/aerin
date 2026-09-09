# Scheduling

Source: `src/tools/schedule-tool.ts` (the `schedule` tool), `src/core/loop.ts` (the `/loop` command), `targetFor`/`ruleFor` in `src/permissions/policy.ts`, the scheduling line in `src/core/system-prompt.ts`, the "Scheduler" section of `aerin doctor` (`src/modes/doctor.ts`), `--output-format`/`--prompt-file` in `src/cli.ts` + `src/modes/print.ts`.

Aerin schedules recurring work through [`every`](https://github.com/serhiileniv/every) — launchd on macOS, systemd user timers on Linux, Task Scheduler on Windows — and **never through cron**. `every` keeps a run history (last run, exit code, captured output), fires missed calendar runs on wake, runs through the login shell in the directory the task was added from, and notifies on failure. cron does none of that and Apple deprecated it years ago.

## Using it

Ask in plain language: "run the tests every night at 2am", "sync my notes every 30 minutes", "why didn't the backup run?". The model uses the `schedule` tool; it does not write crontab entries, plists, or timer units, and it does not suggest cron to you.

| Action | Tier | `every` equivalent |
|---|---|---|
| `list` | read | `every list` — schedule, last/next run, ok/FAIL |
| `inspect <name>` | read | `every inspect <name>` |
| `log <name> [lines]` | read | `every log <name> -n N` — output of recent runs |
| `doctor` | read | `every doctor` — why isn't it running |
| `add <name> <when> <command>` | execute | `every set <when> --name <name> [--timeout] [--quiet] [--on-fail] -- <command>` |
| `run <name> [dry_run]` | execute | `every run <name> [--dry-run]` |
| `pause` / `resume` / `remove` | execute | `every pause` / `resume` / `rm` |

Schedule phrases are `every`'s own: `90s`, `15m`, `2h`, `hourly`, `day 9am`, `day 9am,6pm`, `weekdays 9:30`, `weekends 11am`, `monday 10:00`, `monday,thursday 6pm`.

`add` uses `every set`, so re-adding a name updates the task in place. Tasks run from the working directory aerin was started in; relative paths in the command resolve there.

## `/loop` — recurring agent work

`/loop <when> <prompt>` schedules *aerin itself*: each firing is a fresh headless run, `aerin -p --output-format text --prompt-file <file>`, registered with `every set`. It outlives the session (the terminal can close), has a run history, and is the replacement for anything that would otherwise be a cron line or an in-session polling loop.

```
/loop 15m check CI on main and report failures      # every 15 minutes
/loop day 9am summarize new GitHub issues           # calendar phrases work
/loop once tomorrow 9am remind me to merge #42      # fires once, then removes itself
/loop --name ci --timeout 30m --yolo 1h run the tests and fix what broke
/loop                                               # list loops: schedule, status, last/next run, prompt
/loop log ci [n]  ·  /loop run ci  ·  /loop stop ci
```

- **Schedule grammar is `every`'s**; the command splits it off the front of the prompt per head word (`15m` takes one token, `day`/`weekdays`/`monday,thursday` take a time, `monthly` an ordinal + time, `once` a delay/day/date + time). Write `/loop <when> -- <prompt>` when the prompt itself starts with a time-looking word.
- **Names** default to `loop-` + the prompt's first words (never clobbering an existing task — `-2`, `-3` suffixes), or `--name`.
- **The prompt is a file** (`<data dir>/loops/<name>.md`, read with `--prompt-file`), so no shell quoting of user text on any platform and multi-line prompts survive.
- **Permissions**: a headless run auto-denies anything not covered by allow rules. `--yolo` on the loop, or a session started with `--yolo`, schedules the run with `--yolo`. The reply says which.
- **The aerin binary**: bare `aerin` when it is on PATH, otherwise the running runtime + entry file is pinned (dev checkouts, npx caches). `-m <current model>` is passed so the loop uses the session's model.
- **Timeout** defaults to 10m (`--timeout`) so a hung run cannot pile up behind the next one.
- Each run is a **fresh session with no memory of the last**; pass state through files or the prompt. `/loop log <name>` shows what each run printed.

Only tasks whose command reads a prompt file count as loops; `/loop` never lists or touches plain `schedule` tasks.

## Headless output formats

`aerin -p` prints for scripts and loops. `--output-format text` (default) streams the assistant's text with exactly one newline after each message and at the end; diagnostics (`[tool]`, `[retry]`, `error:`) go to stderr so stdout stays clean. `--output-format json` prints one object at the end:

```json
{"result":"…","isError":false,"sessionId":"…","model":"anthropic/…","toolCalls":3,"usage":{"inputTokens":1200,"outputTokens":340,"costUsd":0.0042}}
```

`--prompt-file <path>` reads the prompt from a file (appended after any argument prompt); the exit code is 1 when the run errored.

## Permissions

Looking (`list`, `inspect`, `log`, `doctor`) is read-tier and works in plan mode; anything that changes what runs on the machine is execute-tier and goes through the normal prompt. Rules match on `<action> <name>`:

```json
{ "permissions": { "allow": ["schedule(list*)", "schedule(add *)"], "deny": ["schedule(remove backup*)"] } }
```

"Yes, always" in the prompt saves `schedule(<action> *)` — the action, not one task name.

## Mechanics

- The tool resolves the binary from `AERIN_EVERY_BIN`, then `~/.local/bin/every` (the installer's default, often missing from a GUI-launched PATH), Homebrew's prefix, then bare `every` on PATH.
- `every` is spawned with an argv, no shell. The command is passed as **one** token after `--`; `every` hands it to the login shell itself, so pipes, `&&`, and globs work and nothing strips quotes on the way.
- Exit codes follow `every`'s sysexits: 66 is explained as "no such task" (or no runs logged yet), 64 as bad arguments; `run` reports the command's own exit code.
- If the binary is missing, the tool errors with the one-line installer and tells the model not to fall back to cron. `aerin doctor` shows the same check.

## Invariants
- `schedule` is the only path to the OS scheduler. No other tool or prompt text mentions crontab as an option.
- `ToolDef.tierFor` decides the tier per call; the static `permission` is the fallback and is what sub-agent toolsets see (the tool is not in the researcher or worker sets).
- Tests never touch the real scheduler: `test/schedule-tool.test.ts` and `test/loop.test.ts` point `AERIN_EVERY_BIN` at a fake script.
- `/loop` is one implementation (`loopCommand` in `src/core/loop.ts`) rendered by both frontends; the scheduled command is always a headless `aerin -p --output-format text --prompt-file …` run, never the prompt text inline.
- Print mode's stdout carries only assistant text (or the one JSON object); everything else is stderr.
