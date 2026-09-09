# Specs

Design records, one per feature. A spec is written **before** a feature (see the spec-driven rule in
the contributor instructions) and kept afterwards as the record of what was decided and why. The
page in `docs/` stays the user-facing feature doc; the spec is the engineering contract behind it.

Specs written after the fact (for features that predate the rule) say so in their status line and
describe the design *as built*, with the gaps listed honestly.

## Template

```markdown
# Spec: <feature>

Status: draft | approved <date> | implemented <date> | retroactive (written <date> for an existing feature)
Doc: docs/<page>.md · Source: <files> · Tests: <files>

## Goal
One paragraph: the user problem and what "done" looks like.

## Non-goals
What this deliberately does not do (and where that lives instead, if anywhere).

## Constraints
Line budget, Windows, layering rule, no new deps, provider quirks — whichever apply.

## Design
The concrete mechanism: data flow, formats, APIs, states, edge cases. Diagrams as text. Quote real
identifiers. For a retroactive spec this is "as built", not aspirational.

## Invariants
Bullet list of properties that must hold. Each one names the test that guards it, or says "untested".

## Acceptance criteria
Numbered, checkable. Map each to an existing test, or mark it as a gap.

## Open questions / known gaps
Honest list. Empty is fine if true.

## Decisions
Dated bullets: what was chosen over what, and why.
```

## Index

| Spec | Status | Acceptance criteria |
|---|---|---|
| [Compaction](compaction.md) | retroactive 2026-09-09 | 20 |
| [Configuration](configuration.md) | retroactive 2026-09-09 | 18 |
| [Deferred MCP tools](deferred-mcp-tools.md) | retroactive 2026-09-09 | 14 |
| [Post-edit diagnostics](diagnostics.md) | retroactive 2026-09-09 | 12 |
| [Doom-loop breaker](doom-loop.md) | retroactive 2026-09-09 | 10 |
| [Goal loop (`/goal`)](goal-loop.md) | retroactive 2026-09-09 | 14 |
| [Hooks](hooks.md) | retroactive 2026-09-09 | 18 |
| [MCP client](mcp.md) | retroactive 2026-09-09 | 11 |
| [Bounded memory](memory.md) | retroactive 2026-09-09 | 20 |
| [Model families — per-family system-prompt addenda](model-families.md) | retroactive 2026-09-09 | 10 |
| [Permissions](permissions.md) | retroactive 2026-09-09 | 17 |
| [Provider failover chains](provider-failover.md) | retroactive 2026-09-09 | 15 |
| [Scheduling — `schedule` tool, `/loop`, headless output formats](scheduling.md) | retroactive 2026-09-09 | 21 |
| [Session search](session-search.md) | retroactive 2026-09-09 | 20 |
| [Sessions](sessions.md) | retroactive 2026-09-09 | 19 |
| [Skills, custom commands and @mentions](skills-and-commands.md) | retroactive 2026-09-09 | 14 |
| [Spill files](spill-files.md) | retroactive 2026-09-09 | 14 |
| [Sub-agents (`agent` tool)](subagents.md) | retroactive 2026-09-09 | 18 |
| [Tool contract and cross-cutting rules](tools.md) | retroactive 2026-09-09 | 22 |
| [TUI polish — one visual system](tui-polish.md) | **approved 2026-09-09, implemented** | 7 |
| [Undo & redo](undo-redo.md) | retroactive 2026-09-09 | 13 |

## Cross-cutting gaps found while writing the retroactive specs

Each spec lists its own; these recur or matter most. Fix candidates, roughly by risk:

- **Integration paths are untested while unit layers are well tested.** `dispatchToolCall` (snapshot-before-bash, print-mode deny, `--yolo` interactions, allow-always persistence), `session:start`/`session:end` call sites, `setupAgent`, and all of `mcp/manager.ts` have no tests.
- **Docs drift from code.** Doom loop is a *consecutive*-run check (`x x x y x` never fires), not "4th time in a turn". Lifecycle hook stdin nests the payload under `input`. Spill filenames are `tool-<ts36>-<6hex>.txt`, not `tool-abc123.txt`. Only the TUI replays history on `--continue`/`--resume`; the REPL does not.
- **Sub-agents run no hooks and get no failover chain**, even though workers write and run commands (`agent-tool.ts` never passes `hooks` or `fallbacks`).
- **Git-less undo fallback misses the `memory` tool** (`Checkpoints` keys on `input.path`, which memory writes lack) despite the header comment claiming coverage.
- **`session_search` read mode joins `session_id` into a path unchecked** — `../x` traversal is possible (read-tier).
- **Sessions persist once per turn in `finally`**; a mid-turn crash loses the turn, append errors are swallowed, and undo history is in-memory only.
- **Two tool schemas break the flat-schema rule** (`todo.items`, `question.options`) and nothing tests the rule.
- **Diagnostics re-run the full typecheck per edit with no baseline**, so a pre-existing type error sends the model off to fix unrelated code.
- **Goal judge cost is never folded into the meter**, and the judge sees only the final message, never tool output.
- **`configSchema` is non-strict**: a misspelled key is dropped silently.
- **System prompt still tells the model to schedule `aerin -p … "<prompt>"` inline**, while `/loop` uses `--prompt-file`; the "never inline" invariant only holds for `/loop`.
