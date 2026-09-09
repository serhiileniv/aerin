# Spec: Doom-loop breaker

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/doom-loop.md · Source: src/core/agent.ts (`turnToolCalls`, `doomLoopApproved`, `DOOM_LOOP_THRESHOLD`, the check in `dispatchToolCall`), src/tools/agent-tool.ts (sub-agent `onPermission`) · Tests: test/doom-loop.test.ts

## Goal

A model that re-issues the same tool call with byte-identical input is stuck: the result will not
change, but every retry costs tokens and, in a long turn, can burn the whole iteration budget. When that
pattern appears, stop and ask the user before the next identical call runs — in any permission tier,
mode, or `--yolo` — and, on a deny, hand the model a message that tells it to change approach. "Done"
means the fourth consecutive identical call never executes silently, a one-time allow costs one keypress,
and legitimate polling can be whitelisted for the session.

## Non-goals

- Detecting semantic loops (same intent, different arguments; alternating A/B calls). Only
  byte-identical JSON input of one tool, consecutively, counts.
- Cross-turn memory. A new `send()` clears the tracker; deliberate repetition across turns is fine.
- Any change to the permission policy or its rules; this is a separate synthetic ask that reuses the
  `OnPermission` channel.
- Persisting the whitelist. `doomLoopApproved` lives for the `Agent` instance only.

## Constraints

- `src/` line budget: the whole feature is ~30 lines in `agent.ts` (state at 199-203, check at 830-857).
- Layering: no UI code; the ask goes through the existing `OnPermission` contract in
  `src/core/events.ts`, so all three frontends and worker sub-agents get it for free.
- Must run after the deferred-tool bridge remap so `tool_call` wrappers compare real MCP tool names.

## Design

### State (per `Agent` instance)

```ts
private turnToolCalls: { name: string; inputJson: string }[] = [];   // cleared at every send()
private doomLoopApproved = new Set<string>();                         // tool names; session-scoped
private static readonly DOOM_LOOP_THRESHOLD = 3;                      // prior identical calls → 4th asks
```

`send()` sets `this.turnToolCalls.length = 0` (`agent.ts:442`). `clear()` does **not** reset
`doomLoopApproved`; only a new `Agent` does.

### Where the check sits in `dispatchToolCall`

1. Deferred-tool bridge remap (`tool_call` → real name/args).
2. Tool lookup and zod validation; `summary = def.summarize(input)`; `tool-call` event yielded.
3. **Doom-loop check** (below).
4. `targetFor` / tier / `policy.decide` — the normal permission path.
5. Pre-hook, permission ask, undo snapshot, execute.

So the breaker sees validated input, fires before deny rules and hooks, and counts calls that are later
denied by the policy too.

### Detection

```ts
const inputJson = JSON.stringify(input ?? null);
const recent = this.turnToolCalls.slice(-Agent.DOOM_LOOP_THRESHOLD);
const isDoomLoop =
  recent.length === Agent.DOOM_LOOP_THRESHOLD &&
  recent.every((c) => c.name === call.toolName && c.inputJson === inputJson) &&
  !this.doomLoopApproved.has(call.toolName);
this.turnToolCalls.push({ name: call.toolName, inputJson });
```

Semantics as built: the **last three** dispatched calls in this turn (of any tool) must all be the same
tool with the same serialized input. It is a consecutive-run check, not a count-in-turn check: `x x x y
x` never fires. `inputJson` is the post-validation zod output for built-ins (defaults applied) and the
raw object for MCP tools; key order is whatever the model sent, so `{a,b}` and `{b,a}` are different.

The current call is recorded before the decision is known, so after a one-time allow or a deny, the next
identical call is again the tail of three identical entries and asks again. Only `allow-always` stops
the asks.

### The ask

```ts
await this.opts.onPermission({
  tool: call.toolName,
  input,
  summary: `Doom loop: ${summary} repeated ${Agent.DOOM_LOOP_THRESHOLD + 1}× with identical input — continue?`,
});
```

`summary` is the tool's own `summarize(input)`, e.g. `Grep(TODO)`. No `preview` is attached. The
frontends render it with their ordinary permission UI (TUI: `Permission · Doom loop: …` with
Yes / Yes, always for this project / No; REPL: `[y]es / [a]lways (project) / [n]o`; print mode: deny
unless `--yolo`, in which case the auto-`allow` lets the loop continue).

### Decisions

| `PermissionDecision` | Effect |
|---|---|
| `{ kind: "allow" }` | This call proceeds to the normal permission path. The tracker still holds the run, so the next identical call asks again. |
| `{ kind: "allow-always", scope }` | `doomLoopApproved.add(toolName)` — the breaker ignores this tool for the rest of the session. `scope` is ignored; nothing is persisted and no allow rule is added. |
| `{ kind: "deny", reason? }` | Returns an error result; the tool does not run. |

Deny text sent to the model:

```
Stopped: you have called <tool> 4 times with IDENTICAL input — repeating it will not produce a
different result.[ The user says: <reason>] Change your approach, or explain what is blocking you.
```

### Sub-agents

Research sub-agents (`agent-tool.ts:143`) have an `onPermission` that always returns
`{ kind: "deny", reason: "Sub-agents cannot request permissions." }`, so a looping researcher gets the
change-your-approach error with that sentence folded in as "The user says: …" — self-correction with no
human involved. Workers (`mode:"worker"`) route through the parent's serialized ask, so the user sees
`Agent(<description>) › Doom loop: …`.

### Parallel dispatch

`dispatchParallel` (used only when a response contains more than one `agent` call) runs several
`dispatchToolCall` generators concurrently; each pushes to the shared `turnToolCalls`, so the recorded
order of parallel identical `agent` calls is scheduling-dependent. In practice the three-identical run
still forms if the calls are identical; a fourth would ask.

## Invariants

- The fourth consecutive identical call asks; the first three run — test/doom-loop.test.ts "the 4th
  identical call asks; denial returns change-your-approach guidance".
- A read-tier tool never asks for any other reason, so the doom-loop prompt is the only ask in that
  test — same test (`asks.length === 1`).
- The deny result is an error carrying `IDENTICAL input`, the user's reason, and `Change your approach`
  — same test.
- `allow-always` suppresses further asks for that tool in the session — test/doom-loop.test.ts
  "allow-always whitelists the tool — no second ask on the 5th identical call".
- Varying inputs never trigger, however many calls — test/doom-loop.test.ts "varying inputs never
  trigger, however many calls".
- Tracking resets per turn: three identical in one turn plus one in the next never asks —
  test/doom-loop.test.ts "tracking resets between turns".
- The check runs after the bridge remap, so a `tool_call` loop is judged on the real tool name — untested.
- The check runs regardless of `--yolo` or mode — untested (the tests use a manual-mode, non-yolo policy
  with a read-tier tool; no test asserts the ask under `--yolo`).
- A denied call still counts toward the run, so the next identical call asks again — untested.
- Research sub-agents receive the deny text without a prompt — untested (test/agent-tool.test.ts checks
  the always-deny callback for permissions in general, not the doom path).

## Acceptance criteria

1. Three byte-identical consecutive calls execute normally; the fourth triggers an `onPermission` request
   whose summary starts with `Doom loop:` — test/doom-loop.test.ts (test 1).
2. Deny returns an error tool result with the guidance text and the user's reason —
   test/doom-loop.test.ts (test 1).
3. `allow-always` whitelists the tool: the fifth identical call runs with no second ask —
   test/doom-loop.test.ts (test 2).
4. Calls with differing inputs never trigger — test/doom-loop.test.ts (test 3).
5. The tracker is per turn — test/doom-loop.test.ts (test 4).
6. The breaker fires for write/execute tools and under `--yolo` — **gap**.
7. A deferred MCP tool looping through `tool_call` is detected under its real name — **gap**.
8. One-time `allow` lets exactly one call through; the next identical call asks again — **gap**.
9. A research sub-agent in a loop is auto-denied with the guidance and keeps going without a human
   prompt — **gap**.
10. The TUI/REPL label the prompt so the user can tell it from a permission ask (the `Doom loop:` prefix
    in `summary`) — **gap** (no frontend test; rendering is the generic permission dialog).

## Open questions / known gaps

- Docs say "4th time in one turn"; the code requires the last three dispatches to be identical
  (consecutive). Interleaving one different call resets the run. Either wording or code should change;
  the consecutive form is probably the intended one (opencode's `doom_loop` is also a consecutive
  check) but it is not stated anywhere.
- `allow-always` scope is ignored and nothing is persisted; the TUI's option text ("always for this
  project") over-promises for this prompt.
- After a one-time allow the model is asked again on the very next identical call, which can feel like
  the breaker did not listen. A "allow N more" option does not exist.
- `doomLoopApproved` survives `/clear`. Probably fine, but undocumented.
- Print mode with `--yolo` auto-allows the ask, so a headless loop is not broken there; without `--yolo`
  the auto-deny does break it. This asymmetry is consistent with "yolo = approve everything not denied"
  but means `/loop` runs get no protection.
- No `AgentEvent` distinguishes a doom-loop ask from a permission ask — frontends rely on the summary
  prefix. A dedicated field would let the TUI hide the "always for this project" option here.
- Acceptance items 6-10 have no tests.

## Decisions

- 2026-07-23 (09496c9, v0.0.104): adopted opencode's `doom_loop` idea as a synthetic permission ask
  rather than a hard stop, so legitimate polling (`bash_output` on a job, retrying a flaky network call)
  can be waved through; threshold 3 prior calls (ask on the 4th) matches opencode. Placed after the
  bridge remap (which already existed from the deferred-tools work) so MCP loops are compared by real
  name, and before the policy so it applies in every tier and under `--yolo`.
- 2026-07-23 (same commit): deny returns guidance instead of a bare error — the message names the count,
  states that repetition will not help, folds the user's typed reason in as steering, and asks the model
  to explain the blocker. The choice to reuse `PermissionDecision` (including `allow-always` as the
  whitelist) kept the frontends unchanged at zero UI lines.
- 2026-07-23 (same commit): per-turn tracking (`turnToolCalls` cleared in `send()`), session-scoped
  whitelist, nothing persisted. Docs page written 2026-07-23 (583f48c).
