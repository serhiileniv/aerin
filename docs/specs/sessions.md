# Spec: Sessions

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/sessions.md · Source: src/session/store.ts, src/config/paths.ts (`sessionsDir`), src/cli.ts (`setupAgent`), src/core/agent.ts (`AgentOptions.store`, `clear`, `loadSession`, `compactNow`, `send`), src/core/session-commands.ts (`resumeById`), src/tui/App.tsx (`/resume`, `replayHistory`), src/modes/repl.ts (`/resume`), src/terminal/format.ts (`redactSecrets`) · Tests: test/session.test.ts

## Goal
Every interactive or headless run persists its conversation so the user can pick it up later —
`aerin --continue` for the most recent conversation in this directory, `aerin --resume <id>` for a
specific one, `/resume` mid-session to switch. "Done" means: a crash never corrupts a session past
the last complete message, resuming reproduces the model-visible history exactly (minus what must
be stripped for provider compatibility), and nothing key-shaped ever lands on disk.

## Non-goals
- Searching across past sessions — that is the `session_search` tool (docs/session-search.md), which
  reads the same JSONL files but has its own loader (`loadSession` in
  src/tools/session-search-tool.ts).
- Shrinking a long history — compaction (docs/compaction.md) decides *what* the history becomes; the
  store only persists the result via `rewrite`.
- Cross-directory sessions: sessions are keyed by cwd and never listed across projects.
- Locking / concurrent writers: two aerin processes in one cwd get two session files; nothing
  guards against two processes opening the *same* id.
- Undo of file changes (docs/undo-redo.md) is per-process shadow-git state, not stored in the session.

## Constraints
- `src/` line budget (10,000, CI-enforced): the store is ~160 lines and must stay a thin file
  format; listing logic lives in the store, picking UI in each frontend.
- Windows first-class: paths come from `env-paths` + `path.join`; the project hash uses
  `path.resolve(cwd)` so `C:\` vs `c:\` casing differences produce different hashes (see Open
  questions). Files are written as `utf8` with `\n` separators regardless of platform.
- Layering rule: `src/session/` imports only `node:*`, `ai` types, `config/paths` and
  `terminal/format` (for `redactSecrets`) — never `ink`/`react` or `src/tui/`. `terminal/format.ts`
  itself imports `tui/theme.js` for colors; that is an existing layering wrinkle outside this spec.
- No new deps: JSONL is written and parsed with `JSON.stringify`/`JSON.parse` only.
- Provider quirks: stored messages must survive the AI SDK's strict `ModelMessage` validation on the
  next request, hence `toPlainJson` and `stripReasoningParts` in agent.ts before persisting.

## Design

### Location
```
<DATA_DIR>/sessions/<projectHash>/<id>.jsonl
```
- `DATA_DIR` = `envPaths("aerin", { suffix: "" }).data` (src/config/paths.ts).
- `projectHash(cwd)` = first 12 hex chars of `sha256(path.resolve(cwd))`.
- `id` = `${Date.now().toString(36)}-${randomBytes(4).hex}` (e.g. `mdfgq3k1-9a2b4c7d`). The time
  prefix is not relied on for ordering; `createdAt` is.

### File format (JSONL)
Line 1 is the meta header; every following line is one `ModelMessage` (from the `ai` package):
```
{"type":"meta","id":"…","cwd":"/abs/path","model":"anthropic/claude-opus-4-8","createdAt":"2026-…Z","title":"fix the login bug"}
{"role":"user","content":"fix the login bug"}
{"role":"assistant","content":[{"type":"text","text":"…"},{"type":"tool-call","toolCallId":"…","toolName":"read","input":{…}}]}
{"role":"tool","content":[{"type":"tool-result","toolCallId":"…","toolName":"read","output":{…}}]}
```
`SessionMeta` fields: `type:"meta"`, `id`, `cwd`, `model` (model at creation — never updated on
`/model`), `createdAt` (ISO), optional `title`.

### Store API (`SessionStore`, src/session/store.ts)
| Member | Behaviour |
|---|---|
| `create(cwd, model)` | `mkdir -p` the dir, write the meta line, return a store. |
| `open(cwd, id)` | Read the whole file, split on `\n`, drop blank lines, `JSON.parse` each; unparsable lines are skipped (torn write), `type:"meta"` becomes the meta, everything else is a message. Throws if no meta line. |
| `list(cwd)` | Read every `*.jsonl` in the dir; unreadable/unparsable files are skipped; returns `SessionSummary[]` sorted by `createdAt` descending. `messageCount` = non-blank lines − 1. Missing dir → `[]`. |
| `latest(cwd)` | `list(cwd)[0]`. |
| `append(messages)` | `appendFile` of `redactSecrets(JSON.stringify(m))` per message, `\n`-terminated. No-op for an empty array. |
| `rewrite(messages)` | Rewrite the file as the *existing* first line + the new messages (redacted). Used after compaction and by `/clear` (`rewrite([])`). |
| `ensureTitle(firstPrompt)` | If no title yet: collapse whitespace, trim, cut at 80 chars, write meta line + existing body. Swallows all errors ("never break a turn over a session title"). |

Title fallback in `list()`: sessions written before titles existed have no `meta.title`; `list()`
scans for the first `role:"user"` message with string content and derives the same 80-char title.
A prompt sent with images has array content and is not used for the fallback.

### Redaction and sanitization
- `redactSecrets` (src/terminal/format.ts) masks `sk-…`, `gsk_…`, `xai-…`, `AIza…`, `csk-…`
  tokens (12+/20+ chars) to `<first 6>…[redacted]`. Applied to every serialized message in
  `append`/`rewrite`, so the redaction happens at the JSON-string level and also hits keys inside
  tool inputs and outputs.
- Before a response reaches `this.messages`/the store, agent.ts applies
  `toPlainJson(stripReasoningParts(m))` and drops assistant messages left with empty content.
  `toPlainJson` = `JSON.parse(JSON.stringify(v))` (kills `undefined` fields that OpenRouter's
  `reasoning_details` attaches); `stripReasoningParts` removes `type:"reasoning"` parts (Groq
  rejects `reasoning_content` on replay).

### Write timing (agent.ts `send`)
1. The user message is pushed to `this.messages` and `newMessages`; `store.ensureTitle(input)` runs.
2. Each model response's sanitized messages and each tool-result message are pushed to both arrays.
3. Auto-compaction inside the loop calls `compactNow()` → `store.rewrite(this.messages)` and then
   sets `newMessages.length = 0` so the `finally` does not re-append messages the rewrite already
   contains.
4. `finally`: `store.append(newMessages).catch(() => {})` — one append per turn, after the turn's
   last event, including on interruption/error (dangling tool calls are patched first). A persist
   failure is silent.

Consequences: the file is written once per turn, not per message; a crash mid-turn loses that turn's
messages except what was rewritten by compaction; a crash mid-append leaves at most one torn last
line, which `open` drops.

### Startup flags (src/cli.ts `setupAgent`)
```
--resume <id>   → SessionStore.open(cwd, id)          (throws if the file is missing → "aerin: ENOENT…", exit 1)
--continue      → SessionStore.latest(cwd) ? open(latest.id) : create(cwd, modelId)
neither         → SessionStore.create(cwd, modelId)
```
`--resume` wins over `--continue`. The opened messages become `AgentOptions.initialMessages`; the
store becomes `AgentOptions.store`; `store.id` becomes `AgentSetup.sessionId`, is passed to
`createSessionSearchTool({ currentSessionId })` so search skips the live file, and is reported to the
`session:start` hook as `{ sessionId, model, resumed: Boolean(resume || continue) }` and to
`session:end` via `teardown`. Print mode (`-p`) goes through the same `setupAgent`, so `-c`/`-r`
work headlessly and `--output-format json` returns the `sessionId`. `latest()` does not filter
empty sessions, so `--continue` after an aborted empty run continues that empty session.

### `/resume` (frontend-shared core, frontend-specific picking)
- Core: `resumeById(ctx, id)` opens the store and calls `agent.loadSession(store, messages)`, which
  swaps `opts.store` and replaces `this.messages` wholesale. Cost/token meters are *not* reset (unlike
  `/clear`).
- TUI (`src/tui/App.tsx`): `/resume <id>` resumes directly; bare `/resume` lists
  `SessionStore.list(cwd).filter(messageCount > 0)` in a `FilterSelect` picker showing
  `relativeTime(createdAt)`, message count and title (`"(no prompt yet)"` fallback). On selection
  `resumeSession` pushes `resumed · N messages`, replays the history via `replayHistory` (user text,
  assistant text, one line per `tool-call` part; tool *results* are not shown) and refreshes the
  context meter. On startup with `-c`/`-r` the same replay runs with `continuing · N messages`.
- REPL (`src/modes/repl.ts`): bare `/resume` prints up to 20 numbered entries (same filter and
  columns) into `resumeChoices`; `/resume <n>` picks by number, any other argument is treated as a
  raw id. Prints `resumed conversation (N messages)`; no transcript replay, and no startup replay
  for `-c`/`-r` either.
- Both frontends catch and print resume errors rather than crashing.

### `/clear`
`agent.clear()` empties the history, resets goal and all token/cost counters, and calls
`store.rewrite([])` — the same session id and file are kept, now containing only the meta line.

### Exit
The TUI prints a plain-text transcript of `agent.history` (prompts and replies only, compaction
markers `[Conversation compacted…` skipped) to normal scrollback through `redactSecrets`, then
`teardown` fires `session:end` with the message count.

## Invariants
- The first line of a session file is always the meta line; `append` never touches it and
  `rewrite`/`ensureTitle` preserve it — guarded by `rewrite preserves meta and replaces messages` and
  `ensureTitle sets the title once …` (test/session.test.ts).
- A torn (unparsable) line is dropped on `open`; the parsable messages before it survive — guarded by
  `torn final line is dropped on load`.
- `list()` orders newest first and `latest()` returns that entry — guarded by `list returns newest
  first and latest() picks it`.
- `messageCount` equals the number of stored messages — guarded by `ensureTitle … reports it with
  counts` and `list() falls back to the first user prompt …`.
- A title is set at most once and never longer than 80 chars — first half guarded by `ensureTitle
  sets the title once …`; the 80-char cap is untested.
- Untitled legacy files get their first string user prompt as title — guarded by `list() falls back
  to the first user prompt for untitled sessions`.
- Messages round-trip through `append`/`open` unchanged — guarded by `create, append, reopen
  roundtrip` (string content only; array content is untested).
- No API-key-shaped string is ever written to a session file — untested at the store level
  (`redactSecrets` itself is exercised elsewhere only if a format test exists; none was found for
  the store path).
- Reasoning parts and `undefined` fields never reach the file — untested (no test constructs a
  provider response with reasoning parts and inspects the file).
- After in-loop compaction the turn's messages are persisted exactly once (no duplication from the
  `finally` append) — untested.
- `--resume` takes precedence over `--continue`; `--continue` with no prior session creates a new
  one — untested (`setupAgent` has no test).
- `/resume` pickers hide sessions with zero messages — untested.
- `session_search` never returns the live session — guarded in test/session-search.test.ts (outside
  this spec's test file; see docs/specs/session-search.md).

## Acceptance criteria
1. `SessionStore.create` writes `<DATA_DIR>/sessions/<hash>/<id>.jsonl` whose first line is a
   `type:"meta"` object — `create, append, reopen roundtrip` (indirectly; the path is only checked in
   `torn final line is dropped on load` via `sessionsDir`).
2. `append` then `open` returns the same messages in order — `create, append, reopen roundtrip`.
3. A file with a truncated last line opens with only the complete messages —
   `torn final line is dropped on load`.
4. `list` returns newest-first and `latest` is `list[0]` — `list returns newest first and latest()
   picks it`.
5. `ensureTitle` sets the title from the first prompt once; later calls are no-ops —
   `ensureTitle sets the title once and list() reports it with counts`.
6. `list` derives a title for pre-title files from the first user prompt — `list() falls back to
   the first user prompt for untitled sessions`.
7. `rewrite` replaces the body and keeps the meta line — `rewrite preserves meta and replaces
   messages`.
8. `list` on a cwd with no sessions dir returns `[]` — gap.
9. `open` on a missing id or a file with no meta line throws — gap.
10. Key-shaped strings in appended messages are redacted on disk — gap.
11. Assistant reasoning parts are stripped and `undefined` fields removed before persisting — gap.
12. One append per turn in `finally`, including after an interrupted turn — gap.
13. In-loop compaction rewrites the file and the turn's messages are not appended twice — gap.
14. `aerin --continue` opens the latest session, or creates one when none exists — gap.
15. `aerin --resume <id>` opens that session and fails loudly on an unknown id — gap.
16. `/resume` (TUI picker, REPL numbered list) lists only sessions with `messageCount > 0`, and
    `/resume <n>` / `/resume <id>` swaps the live agent's store and history — gap.
17. `/clear` leaves the file with only its meta line — gap.
18. The `session:start` hook receives `resumed: true` for `-c`/`-r` and `session:end` receives the
    final message count — gap (hooks tests cover the hook runner, not this payload; unverified).
19. Titles are whitespace-collapsed and capped at 80 characters — gap.

## Open questions / known gaps
- Persistence granularity is per turn: a crash (or `kill -9`) during a long tool-heavy turn loses
  everything since the turn began. Whether that is acceptable or `append` should run per iteration
  is undecided.
- `store.append` failures are swallowed (`.catch(() => {})`) with no event or warning; a full disk
  silently stops persisting.
- `list()` reads every session file in full to compute `messageCount` and legacy titles — O(total
  bytes) per `/resume`. Fine at current scales; no cap or index.
- `latest()` does not skip empty sessions, but the `/resume` pickers do, so `--continue` and
  `/resume` can disagree about which conversation is "the last one".
- `meta.model` is the model at creation and is never updated; `SessionSummary.model` is not shown
  by either picker, so its purpose today is unclear from code.
- `projectHash` hashes `path.resolve(cwd)` without case normalization; on Windows the same directory
  reached via different drive-letter casing yields different session directories. Unverified on a
  Windows machine.
- The REPL does not replay history on `-c`/`-r` or `/resume`; only the TUI does. The doc page says
  `/resume` "replays the conversation" without qualifying the frontend.
- `open` accepts any `id` string and joins it into the path; `/resume ../x` would read outside the
  sessions dir (still `.jsonl`-suffixed). Low impact — the user's own data dir — but unvalidated.
- Setup paths (`setupAgent` flag handling, `resumeById`, `loadSession`, the append/rewrite interplay
  with compaction, redaction on disk) have no automated coverage; acceptance criteria 8–19 are gaps.
- `SECRET_RE` covers five key shapes; other providers' key formats (e.g. OpenRouter, Anthropic
  `sk-ant-` is covered by the `sk-` prefix) are only covered if they share those prefixes.

## Decisions
- 2026-07-22 (initial version, `5c4aa1f`): JSONL with a meta header, append-only and torn-line
  tolerant, chosen over a single JSON document so a crash mid-write cannot lose the whole session and
  a turn can be persisted with one `appendFile`. Sessions keyed by a hash of the cwd under the
  data dir rather than inside the project, so nothing lands in the user's repo.
- 2026-07-22 (`0bc509e`, `5ba45b7`): strip reasoning parts and JSON-sanitize (`toPlainJson`) before
  storing — OpenRouter attached `undefined` fields that failed validation on the next request and
  Groq rejected replayed `reasoning_content`. Streaming reasoning to the UI live is kept.
- 2026-07-22 (`c2d5d8c` v0.0.9, then `98c348c` v0.0.11): `/resume` replaced `/sessions`; sessions
  gained human titles from the first prompt (`ensureTitle`), with a first-user-prompt fallback for
  pre-title files; pickers show relative time + count + title instead of raw ids and hide empty
  sessions; the resumed conversation is replayed into the TUI transcript, also on `-c`/`-r`
  startup. `list()` switched from reading a 4 KB head to the whole file to compute counts.
- 2026-07-22 (`388bf17` v0.0.46, "trust batch"): `redactSecrets` applied in `append`/`rewrite` so
  `cat .env` output never persists — redaction at the serialized-line level rather than per field,
  accepting that it also touches legitimate strings that look like keys.
- 2026-07-22 (`7ede145` v0.0.27): `/clear` keeps the session id and file, rewriting it to the meta
  line only, rather than creating a new session.
- 2026-07-23 (`09dae0d` v0.0.91): session files double as the `session_search` corpus; the live
  session id is threaded into the tool at setup so the current conversation is never surfaced.
- 2026-07-23 (`40887ec` v0.0.111): `session:start`/`session:end` lifecycle hooks receive the
  session id and a `resumed` flag rather than the messages themselves.
- 2026-09-09 (`fea36e0`): `resumeById` moved into `core/session-commands.ts` so both frontends share
  one implementation (they had drifted while duplicated); picking UI stays frontend-specific.
- 2026-09-09 (`2cb7467`): print mode's `--output-format json` includes `sessionId` so headless
  `/loop` runs can be continued or searched later.
