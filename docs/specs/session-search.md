# Spec: Session search

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/session-search.md · Source: src/tools/session-search-tool.ts (registration: src/cli.ts; JSONL shape: src/session/store.ts; truncation: src/tools/types.ts) · Tests: test/session-search.test.ts

## Goal

The agent should be able to recall earlier work in the same project — decisions made, bugs fixed,
files touched, approaches tried — when the user says things like "like we did before" or "that bug
from last week", or when past context would stop it redoing work. "Done" means: the model has a
read-tier tool that (a) finds past sessions of this project by keyword and returns ranked,
role-tagged snippets with session ids, and (b) returns a past session's full transcript when given
one of those ids, so the model can summarize the history itself.

## Non-goals

- No database, index, or embeddings. The session JSONL files are scanned on every call
  (see `docs/sessions.md` for the store).
- No cross-project search: only `sessionsDir(ctx.cwd)` — the directory for the current project
  hash — is read.
- No built-in LLM summarization of transcripts. Read mode returns raw text; the model summarizes.
- No fuzzy/stemmed matching, phrase matching, or ranking by relevance beyond the three-key sort
  described below.
- Not available to sub-agents; `subagentTools()` / `workerTools()` in `src/tools/agent-tool.ts`
  list a fixed toolset that does not include it.
- No redaction at read time — secrets are removed at write time by `SessionStore.append` /
  `rewrite` (`redactSecrets`), so the tool trusts what is on disk.

## Constraints

- `src/` 10,000-line budget (AGENTS.md): the tool is one 173-line file, no helpers elsewhere.
- No new dependencies: only `zod`, `node:fs/promises`, `node:path`.
- Windows first-class: file paths built with `path.join`; JSONL split on `"\n"` (a trailing `\r`
  would be inside the JSON line and `JSON.parse` tolerates it as whitespace).
- Layering rule: lives in `src/tools/`, imports only `./types.js`, `../config/paths.js`, and the
  `SessionMeta` type from `../session/store.js`. No Ink/React.
- Tool schema is flat with primitive types only (two optional strings).
- Provider quirk: both inputs are optional, so the tool itself must reject "neither given".

## Design

### Registration

`src/cli.ts:174`, after the session store is created or resumed:

```ts
tools.push(createSessionSearchTool({ currentSessionId: store.id }));
```

The factory takes `{ currentSessionId?: string; dirOverride?: string }`. `currentSessionId` is
the live session id (excluded from results); `dirOverride` exists for tests and replaces
`sessionsDir(ctx.cwd)`. Registered on the main agent only — sub-agents get `subagentTools()`.

### Tool definition (`ToolDef`)

| Field | Value |
|---|---|
| `name` | `session_search` |
| `inputSchema` | `{ query?: string; session_id?: string }` |
| `permission` | `"read"` (never prompts) |
| `summarize` | `SessionSearch(read <id>)` when `session_id` is set, else `SessionSearch(<query sliced to 60 chars>)` |

### Input data: the session JSONL

One file per session at `<DATA_DIR>/sessions/<projectHash(cwd)>/<id>.jsonl`. Line 1 is a
`SessionMeta` (`{type:"meta", id, cwd, model, createdAt, title?}`); every following line is one
`ModelMessage` (`role` + `content`). The tool has its own loader, `loadSession(file)`, rather than
using `SessionStore.open`, because it needs text per message rather than `ModelMessage` objects:

1. Read the file; on any read error return `undefined`.
2. Split on `"\n"`, drop blank lines, `JSON.parse` each; a line that fails to parse (torn final
   line after a crash) is skipped.
3. `type === "meta"` lines become `meta`; every other line goes through `extractText`.
4. Return `{ meta, parts }` or `undefined` if no meta line was found.

`extractText(msg)` produces `{ role, text }` from one stored message:

- `content` is a string → that string.
- `content` is an array → for each part: `part.text` if it is a string; for `type:"tool-call"`
  the string `` `${toolName}(${JSON.stringify(input)})` ``; for `type:"tool-result"` the
  `output.value` when it is a string. Chunks are joined with `"\n"` and trimmed.
- No role, non-array/non-string content, or empty text → `undefined` (message ignored).

So the searchable corpus per session is: user text, assistant text, tool-call names and inputs,
and tool-result text — which is why a string that only ever appeared in a diff or file read still
matches.

### Mode dispatch (`execute(input, ctx)`)

```
session_id (trimmed) non-empty ─► READ mode
else query (trimmed) non-empty  ─► SEARCH mode
else                            ─► "Provide query keywords to search, or session_id to read a transcript."
```

`session_id` wins when both are supplied.

### Read mode

- File: `path.join(dir, `${sessionId}.jsonl`)`. The id is used verbatim (trimmed); there is no
  validation against path separators or `..` — see known gaps.
- Missing/unloadable → `No session <id> found in this project.`
- Otherwise the output is:

```
Session <id> ("<title | untitled>", <createdAt.slice(0,10)>):

-- <role> --
<text>

-- <role> --
<text>
```

passed through `truncateOutput` (2,000 lines / 30,000 chars, head+tail; the full text is spilled
to `DATA_DIR/spill` with a hint, per `docs/spill-files.md`).

### Search mode

1. **Terms**: `query.toLowerCase().split(/\s+/)`, keep tokens of length ≥ 2, dedupe with `Set`.
   Zero terms → `Query terms are too short — use words of 2+ characters.`
2. **Files**: `readdir(dir)` filtered to `*.jsonl`; readdir failure (no sessions dir yet) →
   `No past sessions found for this project.`
3. **Per file**: skip `` `${currentSessionId}.jsonl` ``; `loadSession`; skip if undefined. Then per
   term:
   - `termHits` starts at 3 if the lowercased title contains the term (title bonus).
   - For each part, `indexOf` the term repeatedly over the lowercased text, counting hits; each hit
     found while `snippets.length < 3` pushes `` `${role}: ${snippet(text, idx)}` ``.
   - Counting stops for that term at 50 hits (`termHits < 50` guard, then `break` out of parts).
   - `termHits > 0` increments `distinct`; `hits += termHits`.
   - A session enters `scored` only if `distinct > 0`.
4. **Snippet**: `snippet(text, index)` takes a 160-char window starting 60 chars before the match,
   flattens whitespace to single spaces, prefixes `…` when the window does not start at 0, and
   always suffixes `…`.
5. **Sort**: `distinct` desc, then `hits` desc, then `meta.createdAt` desc (string compare of ISO
   timestamps).
6. **Output** (`MAX_RESULTS = 5`, `SNIPPETS_PER_SESSION = 3`):

```
<N> past session(s) match "<query>"[ (top 5 shown)]:

1. [<id>] "<title | untitled>" — <yyyy-mm-dd>, <parts.length> messages
   <role>: …snippet…
   <role>: …snippet…

2. ...

Pass session_id to read a full transcript.
```

   also through `truncateOutput`. Zero matches → `No past sessions match "<query>".`

Note that `<parts.length> messages` counts messages with extractable text, not JSONL lines, so it
can be lower than `SessionSummary.messageCount` shown by `/resume`.

### Edge cases (as built)

- Snippets are collected in term order, so up to 3 snippets may all come from the first term.
- The title bonus adds 3 to `hits` but produces no snippet.
- `loadSession` is called for every file on every search; the whole corpus is re-read each call.
  Memory: all sessions are loaded sequentially, one at a time, so peak is one session in memory
  plus the `scored` list (which keeps every matching session's `parts`).
- A session with a meta line but zero extractable messages is still loaded and can match on
  title alone.
- Files ending in `.jsonl` that are not aerin sessions (no meta line) are skipped silently.

## Invariants

- The running session never appears in search results — guarded by
  `finds sessions by keywords with role-tagged snippets, excluding the current session`.
- Text that occurred only in a tool result (or tool-call input) is searchable — guarded by
  `matches inside tool results too`.
- The tool is read-tier (`permission === "read"`) and never asks for permission — guarded by
  `is read-tier and summarizes both modes`.
- Read mode returns every message role-tagged as `-- <role> --` with the session title and
  date — guarded by `reads a full transcript by session_id`.
- Sessions with no matching term are not listed — guarded by the first test
  (`expect(out).not.toContain("[newer-bb]")`).
- No-match, unknown id, and empty input return a plain sentence rather than throwing — guarded by
  `handles no matches, unknown ids and empty input gracefully`.
- Ranking order (distinct terms, then hits, then recency) — untested.
- Title matches weigh extra (+3 hits) — untested.
- Result cap of 5 sessions and 3 snippets per session — untested.
- Per-term hit cap of 50 per session — untested.
- Torn/unparsable JSONL lines are skipped without failing the search — untested (only
  `SessionStore.open` has an equivalent test in `test/session.test.ts`, not this loader).
- Outputs pass through `truncateOutput` — untested here (truncation itself is covered by
  `test/spill.test.ts`).
- Only the current project's session dir is read — untested (tests use `dirOverride`; the
  `sessionsDir(ctx.cwd)` path is never exercised).

## Acceptance criteria

1. Given keywords, the tool returns matching past sessions with `[<id>]`, title, date, and
   `<role>: ` snippets — `finds sessions by keywords with role-tagged snippets, excluding the current session`.
2. The current session (by `currentSessionId`) is excluded from results — same test.
3. Sessions matching none of the terms are omitted — same test.
4. Keywords found only in tool-call inputs or tool-result outputs match — `matches inside tool results too`.
5. Given `session_id`, the tool returns the transcript with `-- user --` / `-- assistant --`
   headers, the quoted title, and full message text — `reads a full transcript by session_id`.
6. A query with no hits returns `No past sessions match …` — `handles no matches, unknown ids and empty input gracefully`.
7. An unknown `session_id` returns `No session <id> found …` — same test.
8. Neither input given returns the `Provide query keywords …` guidance — same test.
9. `permission` is `"read"` — `is read-tier and summarizes both modes`.
10. `summarize` yields `SessionSearch(<query>)` and `SessionSearch(read <id>)` — same test.
11. Results are ordered by distinct terms matched, then hit count, then newest first — gap.
12. A term appearing in the title contributes +3 hits — gap.
13. At most 5 sessions are shown, with `(top 5 shown)` appended when more matched — gap.
14. At most 3 snippets per session — gap.
15. A query whose tokens are all < 2 chars returns the "too short" message — gap.
16. A missing sessions directory returns `No past sessions found for this project.` — gap.
17. A file with a torn final line still loads and can match — gap.
18. Read-mode output longer than the truncation limits is truncated and spilled — gap.
19. `session_id` takes precedence when both inputs are given — gap.
20. The tool is registered on the main agent with the live `store.id`, and not in
    `subagentTools()` / `workerTools()` — gap (no test; verified by reading `src/cli.ts:174` and
    `src/tools/agent-tool.ts:26-37`).

## Open questions / known gaps

- **Path traversal in read mode**: `session_id` is joined into a path unchecked, so
  `../../x` reads `<x>.jsonl` outside the sessions dir. Any file read is still restricted to
  files that parse as an aerin session (needs a `type:"meta"` line), and the tier is read-only, but
  an id format check (`/^[a-z0-9-]+$/`, matching `SessionStore.create`'s `base36-hex` ids) would
  close it. Not covered by tests.
- **Scale**: every search reads and parses every session file. Fine for one project's history
  (the stated design assumption); no measurement exists for what "too many" is.
- **Snippet quality**: snippets come from the first term(s) only and are not deduplicated across
  terms; a session matching many terms may show three near-identical snippets.
- **`messages` count mismatch** between search results (`parts.length`, text-bearing messages
  only) and `/resume` (`messageCount`, JSONL lines minus meta). Cosmetic.
- **Compaction interaction**: after `/compact`, `SessionStore.rewrite` replaces the log with the
  summary plus tail, so search over that session sees the summary text rather than the original
  messages. Whether that is desired is not stated anywhere.
- **No system-prompt guidance**: the model learns when to call the tool from the tool
  description alone; `src/core/system-prompt.ts` does not mention it.
- Ranking, caps, title bonus, and truncation are all untested (criteria 11–19).

## Decisions

- 2026-07-23 (`09dae0d`, v0.0.91): files-as-index over SQLite/embeddings. The header comment
  calls it "Hermes-style, minus the database": a keyword scan is enough at one project's scale and
  keeps aerin dependency-free (AGENTS.md: lean deps, `npx aerin` cold start).
- 2026-07-23 (`09dae0d`): a single tool with two modes (search by `query`, read by `session_id`)
  rather than two tools — keeps the schema flat and the tool count low; the description tells the
  model to search first, then read.
- 2026-07-23 (`09dae0d`): index tool-call inputs and tool-result text, not just prose, so strings
  that only appeared in a diff or file read still match (the `matches inside tool results too`
  test encodes this).
- 2026-07-23 (`09dae0d`): exclude the live session by id (`currentSessionId` from `store.id`,
  `src/cli.ts` comment: "Needs the live session id so search never surfaces the conversation it is
  part of") — it is already in context.
- 2026-07-23 (`09dae0d`): read tier, no prompt. Justified by write-time redaction in
  `SessionStore.append`/`rewrite` (`redactSecrets`), so nothing sensitive can resurface.
- 2026-07-23 (`09dae0d`): main agent only; sub-agents keep the lean research/worker toolsets in
  `agent-tool.ts`.
- 2026-07-23 (`09dae0d`): raw transcript in read mode, no second LLM call — the model summarizes
  past work itself; standard `truncateOutput` bounds the cost.
- 2026-07-23 (`09dae0d`): fixed budgets — 5 results, 3 snippets, 160-char windows, 50 hits per
  term per session, +3 title bonus. No rationale recorded beyond keeping output small; the
  numbers are constants (`MAX_RESULTS`, `SNIPPETS_PER_SESSION`) or inline literals.
- 2026-07-23 (`583f48c`, v0.0.106): user-facing behaviour documented in `docs/session-search.md`
  as part of the docs knowledge base; the code was unchanged.
