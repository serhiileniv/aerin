# Spec: Undo & redo

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/undo-redo.md · Source: src/core/shadow-git.ts (primary), src/core/checkpoints.ts (fallback), src/core/agent.ts (`ensureShadow`, `undo`, `redo`, snapshot call in `dispatchToolCall`, `beginTurn` in `send`), src/core/session-commands.ts (`undoCommand`, `redoCommand`), src/config/paths.ts (`shadowGitDir`), src/tools/agent-tool.ts (`getShadow`), src/cli.ts:237 · Tests: test/shadow-git.test.ts, test/highvalue.test.ts ("checkpoints"), test/reliability.test.ts ("checkpoints bounded depth")

## Goal

`/undo` puts the project back to how it was before the last turn that changed anything on disk —
including files a bash command or an MCP tool touched, not only the write/edit tools — and `/redo`
re-applies it. It must work whether or not the project is a git repository, never copy ignored files
(secrets, `node_modules`) anywhere, restore bytes exactly on Windows, and cost nothing on turns that only
read.

## Non-goals

- Undoing conversation state. `/undo` touches files only; the transcript is unchanged.
- Capturing files outside the work tree (writes under `--allow-outside-cwd`) — documented as not
  captured in the `shadow-git.ts` header.
- Preserving the user's own edits made after the turn: undo restores everything that differs from the
  snapshot, manual edits included. Accepted as the price of catching bash side effects.
- Multi-step redo beyond the chain of undos actually performed, or undo across process restarts.
- Garbage-collecting the shadow object store (`gc.auto=0`); trees accumulate until the user deletes the
  data dir.

## Constraints

- `src/` line budget: `shadow-git.ts` 193 lines, `checkpoints.ts` 55, integration ~25 in `agent.ts`.
- Windows first-class: `core.autocrlf=false` and `core.longpaths=true` are passed on every git call;
  restore paths go over stdin (`checkout-index --stdin -z`) to dodge command-line length limits; spawn
  uses `windowsHide: true`.
- Node-compatible only: `node:child_process` spawn of the `git` binary; no git library dependency.
- Layering: core only; frontends call `undoCommand`/`redoCommand` from `session-commands.ts`.
- Must degrade silently when git is absent or breaks (`broken` latch); no exception may escape into the
  agent loop.

## Design

### Storage

`shadowGitDir(cwd) = DATA_DIR/shadow/<sha256(resolve(cwd)).slice(0,12)>` (`paths.ts:28`). The repo is
created with `git init -q` (idempotent) and used exclusively with `--git-dir <that> --work-tree <cwd>`;
nothing is written inside the project.

Every git call (`ShadowGit.git`) strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`, `GIT_CEILING_DIRECTORIES` from the environment, sets `GIT_TERMINAL_PROMPT=0` and
`GIT_OPTIONAL_LOCKS=0`, adds `-c core.autocrlf=false -c core.longpaths=true -c gc.auto=0`, runs with
`cwd: workTree`, kills after `GIT_TIMEOUT_MS = 60_000`, and rejects on non-zero exit with
`git <verb> exited <code>: <stderr[:300]>`.

### State (`ShadowGit`)

```ts
private turns: string[] = [];          // pre-turn tree hashes, oldest first, ≤ MAX_TURNS (20)
private redoTrees: string[] = [];      // trees captured at undo time (the "after" state)
private needSnapshot = true;           // set by beginTurn(); cleared on first snapshotIfNeeded()
private broken = false;                // any git failure latches this; all ops become no-ops
private snapshotInFlight?: Promise<void>;  // dedupes concurrent callers (parallel workers)
```

### Lifecycle in the agent

- `Agent.shadow: ShadowGit | null | undefined` — `undefined` = not tried, `null` = git unusable.
- `Agent.ensureShadow()`: returns `opts.getShadow()` when set (workers → the parent's instance), else
  lazily `ShadowGit.create(cwd)` once.
- `send()` calls `this.checkpoints.beginTurn()` and `this.shadow?.beginTurn()` after pushing the user
  message (`agent.ts:468-469`). On the very first turn the shadow does not exist yet; `needSnapshot`
  starts `true`, so the first state-changing tool still snapshots.
- `dispatchToolCall` (`agent.ts:933-943`), after the permission gate and before `execute`:
  ```ts
  if (tier !== "read") {
    const shadow = await this.ensureShadow();
    if (shadow) await shadow.snapshotIfNeeded();
    else if (tier === "write") { const p = input.path; if (typeof p === "string" && p) await this.checkpoints.record(path.resolve(cwd, p)); }
  }
  ```
  `tier` is the post-hook-rewrite tier (`tierFor` or `permission`). Read-tier tools never touch either
  mechanism.
- `Agent.undo()` → `this.shadow ? shadow.undoLastChange() : checkpoints.undoLastChange()`;
  `Agent.redo()` → `this.shadow ? shadow.redoLastUndo() : []`. Note `this.shadow` is the field, so before
  any state-changing tool has run (or on a worker, which uses `getShadow`) `undo()` consults the empty
  `Checkpoints` and returns `[]`.

### Snapshot (`snapshotIfNeeded`)

If a snapshot is in flight, await it. If `broken` or `!needSnapshot`, return. Otherwise set
`needSnapshot = false` **before** the work (a failure must not retry on every tool call), then
`writeTree()` = `git add -A .` + `git write-tree`; push the hash on `turns` (shift while > 20); clear
`redoTrees` (new changes invalidate redo). Any error → `broken = true`.

`git add -A` respects the work tree's `.gitignore`, so ignored files never enter the object store.

### Undo (`undoLastChange`)

1. `now = writeTree()` (snapshot the current state; this is what redo restores).
2. Pop trees from `turns` newest-first; `changes = diffTree(tree, now)` using
   `git diff-tree -r -z --name-status --no-renames <tree> <now>`; a turn with no changes is skipped and
   the walk continues.
3. First tree with changes: `restore(tree, changes)`; push `now` on `redoTrees`; return absolute paths.
4. Empty `turns` → `[]`. Any error → `broken = true`, `[]`.

`restore`: `git read-tree <tree>` loads the snapshot into the shadow index; paths with status `A`
(created since the snapshot) are `fs.rm`'d; every other status (`M`, `D`, `T`) is written back with
`git checkout-index -f -z --stdin` fed `path\0path\0…`. Only the changed paths are touched.

### Redo (`redoLastUndo`)

Pop `redoTrees`; `now = writeTree()`; diff and restore exactly as undo; push `now` on `turns` so another
`/undo` reverts the redo. Empty chain or no diff → `[]`.

### Fallback (`Checkpoints`, git unusable)

One `Map<absPath, string | null>` per turn (null = did not exist), `MAX_TURNS = 20`. `record(absPath)`
reads the file once per turn before the first write-tier tool that names it in `input.path`.
`undoLastChange` pops empty turns, then rewrites or removes each captured path, skipping failures. No
redo. Bash/MCP side effects are not captured; nor is any write-tier tool without a `path` input (the
`memory` tool writes `AGENTS.md` and has no `path` field, contrary to the file header's comment).

### User surface

`/undo` → `undoCommand`: `(nothing to undo — no file changes recorded this session)` or
`(reverted N file[s]: a.ts, b.ts — /redo re-applies)` (paths relative to cwd, list cut at 120 chars).
`/redo` → `redoCommand`: `(nothing to redo — /redo only re-applies changes reverted by /undo)` or
`(re-applied N file[s]: …)`. Both frontends (TUI `App.tsx:700-703`, REPL `repl.ts:140-144`) print the
returned line; print mode has no slash commands.

### Workers

`cli.ts:237` passes `getShadow: () => agent.ensureShadow()` into the agent tool; workers get it as
`AgentOptions.getShadow` so their write/bash calls snapshot the **parent's** instance once per parent
turn. `snapshotInFlight` dedupes parallel workers onto one `add -A`.

## Invariants

- Edits, deletions and created files since the snapshot are all reverted, including paths with spaces —
  test/shadow-git.test.ts "undoes edits, deletions and created files — bash-style side effects".
- Redo re-applies an undone turn and a further undo reverts the redo — test/shadow-git.test.ts "redo
  re-applies an undone turn, and undo reverts the redo".
- Turns whose snapshot equals the current tree are skipped — test/shadow-git.test.ts "skips turns that
  changed nothing and undoes the last real change".
- Ignored files are neither stored nor resurrected — test/shadow-git.test.ts "respects .gitignore".
- A new snapshot after an undo empties the redo chain — test/shadow-git.test.ts "a new snapshot
  invalidates the redo chain".
- At most one snapshot per turn; undo with no history returns `[]` — test/shadow-git.test.ts "snapshot is
  taken once per turn and undo returns [] with no history".
- Fallback `Checkpoints` restores edited and created files, newest turn first, skipping empty turns —
  test/highvalue.test.ts "checkpoints" (two tests).
- Fallback depth is bounded at 20 turns — test/reliability.test.ts "keeps at most 20 turns" (asserts
  only that 50 empty turns collapse; the cap itself is not observed).
- Shadow depth is bounded at 20 turns — untested.
- The snapshot runs before write **and** execute tools in the agent loop — untested (no agent-level
  test drives bash then `/undo`).
- Worker writes land in the parent's snapshot — untested (test/agent-tool.test.ts passes
  `getShadow: async () => null` to avoid the real data dir).
- Concurrent `snapshotIfNeeded` callers share one snapshot — untested.
- Any git failure latches `broken` and every later call returns `[]` silently — untested.
- Bytes round-trip unchanged on Windows (CRLF, long paths) — untested (CI runs the suite on Windows but no
  test writes CRLF content).

## Acceptance criteria

1. After a turn whose bash command edited, deleted and created files, `/undo` restores all three —
   test/shadow-git.test.ts (test 1) at the `ShadowGit` level; the agent-loop path is a **gap**.
2. `/redo` after `/undo` re-applies; `/undo` again reverts the redo — test/shadow-git.test.ts (test 2).
3. Read-only turns cost no snapshot and are skipped by `/undo` — test/shadow-git.test.ts (test 3) covers
   the skip; "no snapshot on read-only turns" (`tier !== "read"` guard) is a **gap**.
4. `.gitignore`d files are never copied or restored — test/shadow-git.test.ts (test 4).
5. A new state-changing turn invalidates redo — test/shadow-git.test.ts (test 5).
6. One snapshot per turn, second call in the same turn is a no-op — test/shadow-git.test.ts (test 6).
7. `/undo` with nothing recorded prints the "nothing to undo" line — **gap** (`undoCommand` untested;
   `ShadowGit.undoLastChange` → `[]` is covered by test 6).
8. Without git, write-tool files are still restorable per turn — test/highvalue.test.ts "checkpoints";
   the selection of the fallback in `dispatchToolCall` when `ShadowGit.create` returns null is a **gap**.
9. Undo history is bounded (20 turns) in both mechanisms — test/reliability.test.ts (fallback, weakly);
   shadow: **gap**.
10. Worker sub-agent writes are undone by the parent's `/undo` — **gap**.
11. Undo never touches files outside the work tree or files it did not change — implied by test 1
    (`sp ace.txt` untouched content) and test 4; no explicit assertion — **gap**.
12. The shadow repo lives under the data dir, keyed by cwd hash, never inside the project — **gap** (tests
    pass an explicit `gitDir`; `shadowGitDir` has no test).
13. User `GIT_*` environment variables cannot redirect the shadow plumbing — **gap**.

## Open questions / known gaps

- Undo history is in-memory (`turns`, `redoTrees`); after a restart or `/resume` there is nothing to undo
  even though the object store persists. A persisted ref per session would fix this cheaply.
- `Agent.undo()` reads the `shadow` field, not `ensureShadow()`; before the first state-changing tool
  this silently uses `Checkpoints`. Harmless (both are empty) but a trap for future edits.
- The fallback only captures tools whose input has a `path`; `memory` (write-tier, no `path`) is missed.
  The `checkpoints.ts` header claims memory is covered — the comment is wrong as of today.
- `MAX_OUTPUT`-style guard on `git add -A` of a huge tree: a first snapshot in a large monorepo can take
  seconds and blocks the first write. The 60 s timeout then latches `broken` for the session with no
  message to the user.
- `broken` is never surfaced; the user learns undo is unavailable only via "nothing to undo".
- Rename detection is disabled (`--no-renames`) on purpose so restore stays a per-path operation; a
  renamed file shows as `A` + `D` and both are handled.
- Trees accumulate forever under `DATA_DIR/shadow`; there is no `gc` and no size cap.
- `/clear` does not reset undo history; `/undo` after `/clear` still reverts the previous turn's files.
  Arguably correct, undocumented.

## Decisions

- 2026-07-22 (af5b112, v0.0.26): first `/undo` as in-memory per-turn checkpoints of write/edit paths
  (original content captured before the first write); bash side effects explicitly not covered.
- 2026-07-22 (10b8295, v0.0.51): checkpoint depth capped at 20 turns so marathon sessions stay bounded.
- 2026-07-23 (7c200c4, v0.0.90): replaced the primary mechanism with an OpenCode-style shadow git repo in
  the data dir, work tree = cwd: `add -A` + `write-tree` per turn, `diff-tree` + `read-tree` +
  `checkout-index --stdin` to restore only changed paths. Chosen over copying files because it catches
  bash/MCP side effects, respects `.gitignore` for free, dedupes unchanged blobs, and works without the
  project using git. `/redo` added as the mirror walk. `core.autocrlf=false`, `core.longpaths=true`,
  `gc.auto=0`, `GIT_*` env stripped, `GIT_OPTIONAL_LOCKS=0`. `Checkpoints` kept as the git-less fallback.
  Accepted trade-offs recorded in the file header: manual edits after the turn are reverted; outside-cwd
  writes are not captured; objects are never reclaimed.
- 2026-07-23 (53d1c3a, v0.0.97): worker sub-agents share the parent's `ShadowGit` via
  `AgentOptions.getShadow` (two instances on one index would race; worker writes must be inside the
  parent turn's snapshot); `snapshotInFlight` dedupes parallel workers.
- 2026-07-23 (583f48c, v0.0.106): docs page written; "window is only the most recent turn" and the
  shared-instance rule documented as properties.
