# Spec: Spill files

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/spill-files.md · Source: src/tools/types.ts (`truncateOutput`, `spillFullOutput`), src/config/paths.ts (`DATA_DIR`) · Tests: test/spill.test.ts, test/config.test.ts (`truncateOutput` block)

## Goal

A single tool result must never blow up the context window, but head+tail truncation alone
throws information away — and the model's usual reaction is to re-run the expensive command
(or the same search with a narrower filter) to see what it missed. "Done" means: every tool
result still passes through one shared cap, and whenever anything is cut, the *complete*
output is written to a file outside the project and the truncated result carries a pointer
telling the model to grep or slice that file (or delegate reading it to a sub-agent) instead
of re-running. If the disk write fails for any reason, the model gets plain truncation and
nothing else breaks.

## Non-goals

- Not a cache of tool outputs and not addressable by tool call id — the file name is a
  timestamp plus random bytes; nothing in the transcript or session store references spills
  (grep for `spill` outside `src/tools/types.ts` finds no runtime code).
- Not per-tool policy. Every tool gets the same 30k-char / 2000-line cap; tools with their own
  pre-caps (e.g. `read`'s `limit`, `grep`'s match cap) apply those first and then still pass
  through `truncateOutput`.
- Not a compaction or pruning mechanism for *older* results in the conversation — that is
  `pruneOldToolResults` and `core/compact.ts` (see docs/compaction.md).
- Not a persistence guarantee: 7-day retention, best-effort sweep, no index, no cleanup on
  session end.
- Not a way to smuggle binary output; spills are written as `utf8` text of the string the
  tool already produced.

## Constraints

- `src/` stays under 10,000 lines (CI enforces); the whole feature is ~50 lines in
  `src/tools/types.ts` (113 lines total) and must stay small.
- Windows first-class: paths are built with `node:path`; the spill dir comes from `env-paths`
  (`DATA_DIR`) so no home-dir assumptions. `test/spill.test.ts` deliberately uses a `\0nul`
  path segment so the "broken dir" case fails on every platform.
- Layering rule: `src/tools/types.ts` imports only `node:*`, `zod` types, `../core/events.js`
  (type) and `../config/paths.js` — no ink/react, nothing from `src/tui/`.
- No new deps: `node:fs` (sync), `node:path`, `node:crypto` only. `env-paths` was already a
  dependency for config/session paths.
- Node-compatible only (no `Bun.*` APIs) — enforced by `bun run check:no-bun-globals`.
- Sync fs calls on purpose: `truncateOutput` is a synchronous string function called from
  every tool's `execute`; making it async would change every call site.

## Design

### Entry point and callers

`truncateOutput(text: string, opts?: { spillDir?: string | false }): string` in
`src/tools/types.ts` is the single truncation point. Call sites (all pass no `opts`, so they
use the default spill dir):

| Caller | File:line |
|---|---|
| `bash` | `src/tools/bash.ts:137` |
| `bash` background jobs | `src/tools/bash-jobs.ts:104` |
| `read`, `ls` | `src/tools/fs-tools.ts:79`, `:222` |
| `glob`, `grep`, and the fallback searcher | `src/tools/search-tools.ts:62`, `:168`, `:201`, `:215` |
| `websearch` / `webfetch` | `src/tools/web-tools.ts:100` |
| `agent` (sub-agent report) | `src/tools/agent-tool.ts:231` |
| `session_search` | `src/tools/session-search-tool.ts:104`, `:166` |
| `skill` | `src/tools/skill-tool.ts:25` |
| `schedule` | `src/tools/schedule-tool.ts:174`, `:177` |
| MCP tool results | `src/mcp/manager.ts:101` |

Only tests pass `opts`: `{ spillDir: <tmpdir> }` to observe the file, `{ spillDir: false }`
to disable spilling entirely.

### Caps

```
MAX_OUTPUT_CHARS = 30_000
MAX_OUTPUT_LINES = 2_000
```

Both are exported and used by tests. Truncation runs in two passes on `out` (initially `text`):

1. **Line pass** — if `lines.length > MAX_OUTPUT_LINES`: keep `floor(2000 * 0.75) = 1500` head
   lines, `500` tail lines, and insert one marker line between them:
   `[... output truncated: <N> lines omitted ...]` where `N = lines.length - 2000`.
2. **Char pass** — if `out.length > MAX_OUTPUT_CHARS` (measured *after* the line pass): keep
   `floor(30000 * 0.7) = 21000` head chars, `9000` tail chars, joined by
   `\n[... output truncated: <M> chars omitted ...]\n` where `M = out.length - 30000`
   (note: `M` is relative to the line-truncated string, not the original).

Head AND tail are kept because errors and summaries usually live at the end of command
output (source comment; introduced in 9bde87e).

### Spill

After both passes, `if (out !== text && opts?.spillDir !== false)`:

- `dir = opts?.spillDir ?? path.join(DATA_DIR, "spill")`. `DATA_DIR` is
  `envPaths("aerin", { suffix: "" }).data` (`src/config/paths.ts`) — e.g.
  `~/Library/Application Support/aerin` on macOS, `$XDG_DATA_HOME/aerin` (default
  `~/.local/share/aerin`) on Linux, `%LOCALAPPDATA%\aerin\Data` on Windows. Same root as
  `sessions/` and `shadow/`, so spills never live inside the project.
- `spillFullOutput(text, dir)`:
  1. `fs.mkdirSync(dir, { recursive: true })`.
  2. **Sweep, once per process**: module-level `sweptThisProcess` flips to `true` before the
     loop; every entry in `dir` whose `mtimeMs` is older than `SPILL_RETENTION_MS`
     (`7 * 24 * 3600 * 1000`) is `fs.rmSync(fp, { force: true })`. A `statSync`/`rmSync`
     failure on one entry is swallowed and the entry left alone.
  3. File name: `tool-<Date.now().toString(36)>-<crypto.randomBytes(3).toString("hex")>.txt`
     (e.g. `tool-m1abc2de-9f3a1c.txt`). Written with `fs.writeFileSync(file, text, "utf8")` —
     the ORIGINAL `text`, not the truncated `out`.
  4. Returns the absolute file path, or `undefined` if anything in the `try` threw.
- When a path comes back, the hint is appended to `out`:

```
\n[full output (<text.length> chars) saved to <file> — grep it or read it with offset/limit
for the omitted parts instead of re-running the command; for broad analysis, delegate
reading it to an agent]
```

  When `spillFullOutput` returns `undefined`, `out` is returned with only the truncation
  markers — the model sees plain truncation and no error.

### Flow

```
tool.execute() ──► truncateOutput(text)
                     │ line pass (1500 head / 500 tail)
                     │ char pass (21000 head / 9000 tail)
                     ├─ out === text ─────────────────────────────► return text
                     └─ cut, spillDir !== false
                          ├─ spillFullOutput(text, dir)
                          │     mkdir -p; sweep(>7d) once/process; write tool-*.txt
                          │     ├─ ok ──► path
                          │     └─ throw ──► undefined
                          ├─ path      ──► return out + "[full output ... saved to <path> — ...]"
                          └─ undefined ──► return out
```

### How the model consumes a spill

The hint names two existing tools: `read` accepts `offset`/`limit` (1-based line, default
2000 lines) and `grep` accepts a `path` argument (`src/tools/search-tools.ts:147`). The `read`
tool's outside-cwd guard only refuses paths matching `SENSITIVE_RE`; `tool-*.txt` under
`DATA_DIR` does not match it, so no `--allow-outside-cwd` is needed. Reading a spill file
goes back through `truncateOutput`, so a 2000-line window of a spill can itself spill if it
exceeds 30k chars (see known gaps).

### Edge cases (as built)

- Exactly `MAX_OUTPUT_LINES` lines or exactly `MAX_OUTPUT_CHARS` chars: not truncated
  (`>` comparisons), no spill.
- Both caps exceeded: line pass first, then char pass on the already-shortened string; one
  spill file holding the original text.
- `spillDir: false` is the only opt-out; `undefined` means "default dir".
- The sweep runs at most once per process regardless of `dir` — a test using several tmp
  dirs only sweeps the first one it touches; the real dir is swept on the first spill of a
  session, not at startup.
- Spill file name collision: `Date.now()` base-36 + 3 random bytes; two spills in the same
  millisecond collide with probability 2^-24. Not guarded.
- CRLF: `split("\n")` leaves `\r` on line ends; counts are per `\n`. The spill file is the
  untouched original bytes-as-string, so CRLF is preserved there.

## Invariants

- The spill file content is byte-identical to the original tool output (`text`, not `out`).
  — `test/spill.test.ts` "truncation saves the FULL output to a spill file and points the
  model at it".
- The hint reports `text.length` (original char count), not the truncated length.
  — same test (`expect(out).toContain(\`${big.length} chars\`)`).
- The spill path in the hint lives under the configured `spillDir`. — same test
  (`spillPath.startsWith(dir)`).
- Char-cap-only truncation (no line-cap hit) also spills, and exactly one file is written
  per truncated result. — `test/spill.test.ts` "char-cap truncation spills too".
- Output at or under both caps is returned unchanged and creates no file.
  — `test/spill.test.ts` "short output never spills; spillDir:false disables spilling";
  `test/config.test.ts` "passes short output through".
- `spillDir: false` yields truncation markers and no `saved to` hint. — `test/spill.test.ts`
  "short output never spills; spillDir:false disables spilling".
- A spill dir that cannot be created degrades to plain truncation; `truncateOutput` never
  throws because of the disk. — `test/spill.test.ts` "a broken spill dir degrades to plain
  truncation".
- Truncation keeps both head and tail, and the result stays near `MAX_OUTPUT_LINES` lines.
  — `test/config.test.ts` "caps line count keeping head and tail".
- Every tool's `execute` return passes through `truncateOutput` (12 call sites listed above).
  — untested (no test asserts the call-site set; a new tool can skip it silently).
- Spills are written under `DATA_DIR`, never inside `cwd`. — untested (default path only
  exercised by production code; tests always pass a tmp dir or `false`).
- Files older than 7 days are removed on the first spill of a process; newer files are kept.
  — untested.
- The sweep never runs more than once per process. — untested.
- `truncateOutput` is synchronous and has no side effects when nothing is cut. — untested
  directly (implied by the "short output never spills" readdir check).

## Acceptance criteria

1. Output exceeding `MAX_OUTPUT_LINES` is truncated to ≈2000 lines with head and tail
   retained and a `[... output truncated: N lines omitted ...]` marker.
   — `test/config.test.ts` "caps line count keeping head and tail".
2. Output exceeding `MAX_OUTPUT_CHARS` is truncated with head and tail retained and a
   `[... output truncated: M chars omitted ...]` marker. — partially covered:
   `test/spill.test.ts` "char-cap truncation spills too" checks only `saved to`; head/tail
   retention for the char pass is a **gap**.
3. Any truncation writes the complete original output to a file in the spill dir.
   — `test/spill.test.ts` "truncation saves the FULL output ...".
4. The truncated result ends with a hint naming the spill path, the original char count,
   and the grep/offset-limit/delegate guidance.
   — `test/spill.test.ts` "truncation saves the FULL output ..." (checks path, char count,
   and the `grep it or read it with offset/limit` phrase; the "delegate reading it to an
   agent" clause is not asserted — minor gap).
5. Output within both caps is returned as-is and no file is created.
   — `test/spill.test.ts` "short output never spills ..."; `test/config.test.ts` "passes
   short output through".
6. `{ spillDir: false }` disables the file write and the hint while keeping truncation.
   — `test/spill.test.ts` "short output never spills; spillDir:false disables spilling".
7. A failing spill (unwritable/uncreatable dir) produces plain truncation with no hint and
   no exception. — `test/spill.test.ts` "a broken spill dir degrades to plain truncation".
8. Exactly one spill file is created per truncated result.
   — `test/spill.test.ts` "char-cap truncation spills too" (`readdir` length 1).
9. The default spill dir is `path.join(DATA_DIR, "spill")` (outside the project).
   — **gap** (never asserted; only visible in source).
10. Spill files older than 7 days are deleted on the first spill of a process; files newer
    than 7 days survive. — **gap**.
11. The sweep runs at most once per process. — **gap**.
12. Every built-in tool, MCP wrapper, and sub-agent report passes its result through
    `truncateOutput`. — **gap** (no test enumerates call sites; relies on review).
13. Spill file names are unique per call (`tool-<ts36>-<6 hex>.txt`). — **gap**.
14. The spill file preserves the original line endings (CRLF untouched). — **gap**.

## Open questions / known gaps

- **Recursive spill on read**: reading a spill file with `read` runs the slice back through
  `truncateOutput`; a 2000-line window over 30k chars will spill a second file pointing at
  a *third* view of the same data. Harmless but wasteful; not handled.
- **Sweep timing**: retention is enforced only when a spill happens; a machine that never
  truncates again keeps old files forever. Also the sweep is keyed on the first `dir` seen
  in the process — in the real CLI that is always the default dir, but the once-per-process
  flag is global, not per-dir.
- **Sub-agents run in-process** (`agent-tool.ts`), so their tool outputs spill into the
  same dir and count against the same sweep flag. Whether the parent's hint should mention
  that a sub-agent's spills exist is unaddressed.
- **Char-count in hint vs. tokens**: the hint says chars; the model has no size-in-tokens
  hint. Not a bug, just a choice.
- **No test for the default path, retention, sweep-once, or name uniqueness** (AC 9–13).
  A test for retention would need to stat-mutate a tmp file's mtime and reset
  `sweptThisProcess`, which is module-private — testing it requires either exporting a
  reset hook or spawning a fresh process.
- **`\0nul` broken-dir test** relies on Node rejecting NUL bytes in paths; it does not
  exercise the EACCES / read-only-filesystem path, which is the realistic production failure.
- **Hint wording is not centralized**: `docs/spill-files.md` quotes the hint with a
  `<data>/spill/tool-abc123.txt` example name that does not match the real
  `tool-<ts36>-<hex>.txt` shape. Cosmetic.
- Unclear from code whether the system prompt should mention spill files explicitly; today
  it does not (grep `spill` in `src/core/system-prompt.ts` finds nothing) — the model learns
  about them only from the appended hint.

## Decisions

- **2026-07-22 (9bde87e)** — Head+tail truncation replaces head-only. Previous
  implementation kept the first 2000 lines / 30k chars and appended
  `[output truncated — original was N chars / L lines]`; errors at the end of command output
  were being cut. Split chosen: 75/25 for lines, 70/30 for chars (no recorded rationale
  for the different ratios — unclear from code).
- **2026-07-23 (88c0840, v0.0.105)** — Spill files added, explicitly "opencode-style"
  (source comment): instead of asking the model to re-run with narrower filters, keep the
  full output on disk and point at it. Chosen over (a) raising the caps — would cost context
  on every big result — and (b) storing outputs in the session JSONL — would bloat sessions
  and be re-read on resume.
- **Same commit** — Spill failure is silent by design ("Any failure means no spill —
  truncation alone still protects the context"): context protection must never depend on
  the disk write, so `spillFullOutput` is wrapped in a single `try/catch` returning
  `undefined`.
- **Same commit** — Location is `DATA_DIR/spill`, alongside `sessions/` and `shadow/`, so
  spills are never inside the project and cannot be committed. A per-project subdir (as
  sessions use, via `projectHash`) was not used — spills are not project-scoped.
- **Same commit** — 7-day retention, swept once per process and only when a spill occurs.
  Chosen over a startup sweep so cold-start (`npx aerin`) does not pay a readdir on every
  launch.
- **Same commit** — Opt-out is `spillDir: false` rather than an env var or config key; the
  only consumers are tests (`test/config.test.ts` updated in the same commit to pass
  `false`), and production callers never need to disable it.
- **Same commit** — The hint tells the model to delegate broad analysis to a sub-agent,
  matching the system prompt's guidance that exploratory reading belongs in the `agent`
  tool's own context window.
- **2026-09-09 (2cb7467)** — `schedule` tool routes its output through `truncateOutput`
  like every other tool; no change to the spill mechanism itself. `ToolDef.tierFor` added
  to the same file (unrelated to spills).
