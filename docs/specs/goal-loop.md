# Spec: Goal loop (`/goal`)

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/goal-loop.md · Source: src/core/goal-judge.ts, src/core/agent.ts (`setGoal`/`startGoal`/`currentGoal`/`judgeModel`/`effectiveSystemPrompt` and the finished-turn branch of `send()`), src/core/session-commands.ts (`goalCommand`), src/cli.ts (`getJudgeModel` wiring), src/modes/print.ts (`diagnostic`), src/tui/App.tsx and src/modes/repl.ts (dispatch + rendering) · Tests: test/goal-loop.test.ts, test/highvalue.test.ts ("goal / plan / mode commands drive agent and policy")

## Goal

A user who types `/goal make the test suite pass` wants the agent to keep working across turn boundaries until the goal is demonstrably achieved, without being asked "should I continue?" after every finished turn. "Done" means: the agent starts immediately, each finished turn is judged by a small evidence-requiring LLM call, a not-done verdict feeds back as steering and the agent continues on its own, a done verdict disarms the loop, and a hard turn budget guarantees the loop always terminates — in every frontend (TUI, REPL, headless) with no frontend-specific logic.

## Non-goals

- Verifying the agent's claims against tool output. The judge sees only the assistant's own final text (last 4,000 chars), not tool results. Evidence is demanded by prompt, not checked by machine.
- A headless entry point. There is no `--goal` CLI flag; `aerin -p` runs a single turn (see docs/specs/scheduling.md for the scheduled-run story).
- Persisting a goal across sessions. `goal` lives on the `Agent` instance only; `--continue`/`--resume` restore history, not the armed goal.
- Replacing the `turn:end` lifecycle hook (docs/hooks.md). Both can send the agent back to work; the goal loop runs first and the hook only sees turns the loop lets finish.
- Metering the judge's own tokens (see known gaps).

## Constraints

- `src/` line budget (10,000, CI-enforced): the whole feature is `goal-judge.ts` (53 lines) plus roughly 40 lines in `agent.ts` and 17 in `session-commands.ts`.
- Layering rule: the loop lives inside `Agent.send()` (core); frontends only render the `goal-check` event and forward `/goal` to `goalCommand`. No frontend may re-implement continuation.
- No new dependencies: the judge is one `generateText` call from the already-present `ai` package.
- Provider quirks: models wrap JSON in prose or code fences, so the verdict is extracted with a regex rather than parsed strictly; any failure is fail-open.
- Windows: nothing platform-specific in this feature.

## Design

### State on `Agent` (src/core/agent.ts)

```
private goal: string | undefined;   // pinned into every request's system prompt
private goalTurnsLeft = 0;          // 0 = loop disarmed
```

- `setGoal(goal)` — trims; empty/undefined unpins and sets `goalTurnsLeft = 0`.
- `startGoal(goal)` — `setGoal(goal)` then `goalTurnsLeft = opts.maxGoalTurns ?? 20`.
- `currentGoal` — getter for `/goal` (no arg) and `/status` (`mode … · goal: <first 50 chars>`).
- `clear()` calls `setGoal(undefined)`: a cleared session is a fresh start.
- `AgentOptions.maxGoalTurns?: number` (default 20) and `AgentOptions.getJudgeModel?: () => LanguageModel`.
- `judgeModel()` returns `getJudgeModel?.() ?? activeModel`, catching a throwing resolver and falling back to `activeModel` (a bad `subagentModel` config never crashes a turn). `cli.ts` passes `getJudgeModel: () => resolveModel(config.subagentModel, config)` only when `subagentModel` is set.
- `effectiveSystemPrompt()` appends, while a goal is set (armed or exhausted):
  `\n\nSession goal (set by the user — keep every action pointed at it):\n<goal>`.

### Arming (src/core/session-commands.ts `goalCommand`)

| Input | Effect | Returns |
|---|---|---|
| `clear` or `off` | `agent.setGoal(undefined)` | `{ message: "(goal cleared — autonomous loop stopped)" }` |
| `<text>` | `agent.startGoal(text)` | `{ message: "goal armed — working autonomously until the judge sees it done: <text>", run: text }` |
| empty | nothing | current goal, or `"(no goal set — /goal <text> starts an autonomous goal loop; /goal clear stops it)"` |

Both frontends print `message` and, when `run` is present, submit it as a normal user turn (`runTurn(res.run)` in App.tsx and repl.ts). The TUI also keeps a `goalSet` flag for its footer, synced on `/goal`, on `goal-check{done:true}`, and on `/clear`.

### The finished-turn branch (`Agent.send()`)

Each model call is one `iteration` of the tool loop; `turnText` accumulates that iteration's `text-delta`s. When an iteration ends with `toolCalls.length === 0` (the model stopped calling tools), in this order:

1. `drainInjected(newMessages)` — a user message queued mid-turn is appended and the loop `continue`s. User input always preempts judging.
2. If `this.goal && this.goalTurnsLeft > 0`:
   1. `verdict = await judgeGoal(judgeModel(), goal, turnText, abort.signal)`.
   2. If the turn was aborted during the judge call: `finished = true; break` (goal stays armed).
   3. `goalTurnsLeft--`; `exhausted = !verdict.done && goalTurnsLeft === 0`.
   4. Yield `{ type: "goal-check", done, reason, turnsLeft }`, where `reason` gets the suffix ` — goal turn budget exhausted; /goal again to keep going` when exhausted.
   5. `done` → `setGoal(undefined)` (disarm and unpin), fall through to the normal end of turn.
   6. not done and not exhausted → push a continuation **user** message onto both `this.messages` and `newMessages` (so it is persisted in the session file):
      ```
      [goal check] Not complete yet: <reason>
      Keep working toward the goal: <goal>
      When it is truly done, state the concrete evidence (test output, diffs, command results).
      ```
      then `iteration = -1; continue` — the next goal turn gets a fresh `maxIterations` tool budget.
   7. exhausted → fall through; the goal string stays pinned with `goalTurnsLeft = 0`, so `/goal <same text>` re-arms with a full budget and the system prompt keeps pointing at it.
3. Only then the `turn:end` lifecycle hook runs (capped at 3 blocks per turn).

Everything above happens inside one `send()` generator, so both model turns of a goal run stream through the same event consumer.

### The judge (src/core/goal-judge.ts)

`judgeGoal(model, goal, report, abortSignal?) → Promise<GoalVerdict>` with `GoalVerdict = { done: boolean; reason: string }`.

- One `generateText` call, `maxOutputTokens: 200`, system prompt `JUDGE_SYSTEM`: respond with ONLY `{"done": true|false, "reason": "one short sentence"}`; `done=true` ONLY on concrete evidence (command output, test results, file changes); plans, promises, questions, partial progress are `false`; when unsure, `false` with the missing evidence as the reason.
- User content: `Goal:\n<goal>\n\nAgent's latest report (tail):\n<report.slice(-4000) || "(the agent produced no text this turn)">\n\nJudge now.`
- Parsing: first `/\{[\s\S]*\}/` match → `JSON.parse`; `done` is `j.done === true` (anything else is false); `reason` is the trimmed string or `"(no reason given)"`.
- **Fail-open**: any throw (provider error, no JSON, unparsable JSON) returns `{ done: false, reason: "(judge unavailable — continuing; the turn budget bounds the loop)" }`. The judge steers; it never gates.

### Event and rendering

`AgentEvent`: `{ type: "goal-check"; done: boolean; reason: string; turnsLeft: number }` (src/core/events.ts). `turnsLeft: 0` with `done: false` means the budget ran out.

| Frontend | Rendering |
|---|---|
| TUI (App.tsx) | info line `✓ goal complete · <reason>` or `goal continues · <N> turns left · <reason>` |
| REPL (repl.ts, via `diagnostic()`) | `  [goal complete] <reason>` / `  [goal continues <N>] <reason>` |
| Print (print.ts) | same `diagnostic()` line on stderr; stdout carries only assistant text |

### State machine

```
disarmed ──/goal <text>──▶ armed(N=20) ──finished turn──▶ judge
   ▲                          ▲                            │
   │ /goal clear · /clear     │ not done, N>1: continuation user msg, N-1
   │ done verdict             │
   └──────────────────────────┴── not done, N==1 ──▶ exhausted (goal pinned, N=0; /goal <text> re-arms)
```

Abort (Esc/Ctrl+C) during a goal turn ends the turn; the goal stays armed with its remaining budget, and the next finished turn — whatever the user asks — is judged against it.

## Invariants

- The loop is frontend-free: both model turns of a continued goal stream through one `send()` — guarded by "continues after a not-done verdict and stops when the judge sees completion" (test/goal-loop.test.ts).
- The judge never throws and never gates: a throwing model or non-JSON output yields `done:false` — "fails open on judge errors and non-JSON output"; and the agent loop emits no `error` event when the judge is broken — "a broken judge fails open — the loop runs to its budget instead of dying".
- Termination: at most `maxGoalTurns` verdicts per arming, then `turnsLeft: 0` with the exhausted suffix — "stops at the turn budget with the goal still pinned for resumption".
- Exhaustion keeps the goal pinned (`currentGoal` unchanged) so it can be resumed — same test.
- Achievement disarms and unpins (`currentGoal === undefined` after `done:true`) — "continues after a not-done verdict…".
- The continuation rides as a `user` message containing `[goal check]` in `agent.history` — same test.
- No armed goal → no judge call, ever — "without an armed goal, send() never judges".
- `/clear` and `/goal clear` disarm — "/clear drops the goal and disarms the loop…" and "/goal clear disarms the loop".
- `goalCommand` arms via `startGoal` and hands the frontend a `run` prompt — test/highvalue.test.ts "goal / plan / mode commands drive agent and policy".
- Judge output is parsed leniently (prose around the JSON is tolerated) — "parses verdicts, tolerating prose around the JSON".
- The judge prefers `getJudgeModel` over the active model — exercised by every loop test (the judge mock is the `getJudgeModel` return), but the fallback when the resolver throws is **untested**.
- The goal is pinned into the system prompt while set — **untested**.
- Aborting during the judge call ends the turn with the goal still armed — **untested**.
- A mid-turn injected user message is drained before judging — **untested**.
- The judge sees only the last 4,000 chars of the final assistant message — **untested**.

## Acceptance criteria

1. `/goal <text>` arms the loop and immediately submits `<text>` as a turn. — test/highvalue.test.ts "goal / plan / mode commands" (arming + `run`); the frontend submission itself is a **gap** (no TUI/REPL test).
2. After a finished turn with a not-done verdict the agent continues within the same `send()` and the continuation is a persisted user message. — test/goal-loop.test.ts "continues after a not-done verdict…".
3. A done verdict emits `goal-check{done:true}`, disarms and unpins. — same test.
4. At most `maxGoalTurns` verdicts; the last one carries `turnsLeft: 0` and "budget exhausted" in `reason`. — "stops at the turn budget…".
5. After exhaustion `currentGoal` is unchanged, so `/goal <same>` resumes. — same test (re-arming itself is a **gap**).
6. A judge that throws or returns junk never stops the loop or surfaces an `error` event. — "fails open…" and "a broken judge fails open…".
7. `judgeGoal` accepts prose around the JSON and treats any `done` other than literal `true` as not done. — "parses verdicts…" (the non-`true` case, e.g. `"done": "yes"`, is a **gap**).
8. No `goal-check` is emitted when no goal is armed. — "without an armed goal, send() never judges".
9. `/clear` and `/goal clear` both disarm. — the two disarm tests.
10. Each continued goal turn gets a fresh tool-iteration budget (`iteration = -1`). — **gap** (tests use text-only turns).
11. Verdicts go to the `subagentModel` when configured, else the active model, and a throwing resolver falls back to the active model. — preference covered implicitly by the loop tests; fallback is a **gap**.
12. The `goal-check` line renders as specified in TUI, REPL and print. — **gap** (print.ts `diagnostic` has no goal-check test; App.tsx untested).
13. An interrupt during a goal turn leaves the goal armed. — **gap**.
14. `/status` shows the goal when one is set. — **gap**.

## Open questions / known gaps

- The judge's `generateText` usage is not folded into `totalInputTokens`/`totalCostUsd`; the cost meter under-reports by roughly one small call per finished turn. Untested and undocumented.
- The judge reads only the assistant's self-report, never tool output, so a confident but false "tests pass" completes the goal. docs/goal-loop.md calls this "evidence required"; strictly it is "evidence demanded".
- `turnText` is per-iteration: when the final iteration is text-only after several tool iterations, only that final message is judged. Intended (it is the report) but a turn whose last message is a one-liner gives the judge almost nothing.
- While a goal is armed, an unrelated question is answered and then judged against the goal, pulling the agent back (by design per docs/goal-loop.md, but surprising; `/goal clear` is the escape).
- After exhaustion the goal stays pinned in the system prompt indefinitely (until `/goal clear` or `/clear`), with no visible reminder except `/status`.
- No test drives the TUI/REPL dispatch of `/goal` or the rendering of `goal-check`.
- `maxGoalTurns` is not configurable from `aerin.json`; only `AgentOptions` (used by tests) sets it.

## Decisions

- 2026-07-22 (9ac66b2, v0.0.54): `/goal` first shipped as a system-prompt pin only (`setGoal`), no autonomy.
- 2026-07-23 (c9da344, v0.0.103): autonomy added, adopted from Hermes Agent's "Ralph loop". An LLM judge was chosen over the model self-declaring completion because the agent's own "done" is what the loop exists to distrust.
- 2026-07-23: fail-open over fail-closed — a dead judge must not become a dead loop; the turn budget (20) is the sole hard bound. Recorded in the `goal-judge.ts` header comment and in the test "a broken judge fails open".
- 2026-07-23: the loop lives in `Agent.send()` rather than in frontends, so TUI, REPL and print get identical behaviour and the two model turns stream through one generator (test comment: "the loop is frontend-free").
- 2026-07-23: the continuation is a `user` message in history, not a system-prompt tweak, so it is persisted, visible on `--continue`, and compacts like anything else.
- 2026-07-23: a fresh tool-iteration budget per goal turn (`iteration = -1`), because a continued goal is a new turn from the model's point of view.
- 2026-07-23: judge on `subagentModel` when configured — the verdict is a ~200-token call and should not cost the primary model's price; resolver failures fall back silently rather than crash.
- 2026-07-23: judge input capped at the last 4,000 chars and output at 200 tokens, bounding the per-turn overhead.
- 2026-09-09 (ab0a0db, TUI polish spec §9): rendering changed from `✓ goal complete —` / `↻ goal continues (…) —` to the bare ` · ` meta-line grammar.
