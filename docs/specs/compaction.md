# Spec: Compaction

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/compaction.md · Source: src/core/compact.ts, src/core/agent.ts (`compactNow`, `pruneOldToolResults`, the send-loop trigger), src/core/session-commands.ts (`compactCommand`) · Tests: test/compact.test.ts, test/reliability.test.ts (`pruneOldToolResults`)

## Goal

A long session must keep working after the conversation outgrows the model's context window,
without the user noticing more than a one-line "compacted context" notice. When the last request
used more than 80% of the window, the older part of the history is folded into a structured
running summary and the recent tail is kept verbatim, so the model retains the goal, decisions,
completed work and next steps. Repeated compactions update that summary in place instead of
summarizing a summary, so a session that compacts ten times still has a usable memory of turn
one. "Done" means: the next request fits, tool-call/result pairs are never split, the session
file on disk matches the live history, and `/compact` gives the same result on demand.

## Non-goals

- Persisting knowledge across sessions — that is the memory tool (`docs/memory.md`) and
  session search (`docs/session-search.md`).
- Shrinking individual tool outputs at the time they are produced — spill files
  (`docs/spill-files.md`, `truncateOutput`) do that; compaction only sees what survived.
- Warning the model mid-task that context is nearly full. Deliberately not done (see Decisions).
- Letting the user choose what to keep, or editing the summary. There is no UI for either.
- Choosing a cheaper model for the summary call. It runs on the active model.

## Constraints

- `src/` stays under 10,000 lines (CI-enforced); `compact.ts` is 150 lines and pays rent by
  being the only summarizer for all three frontends.
- Layering: `core/compact.ts` imports only `ai` and `providers/models.ts`; frontends only see the
  `{ type: "compaction", preTokens }` event in `core/events.ts` and `compactCommand`'s string.
- No new dependencies: token counts are the ~4 chars/token estimate used everywhere in aerin
  (`estTokens`, `Agent.estimateContextTokens`), not a tokenizer.
- Provider quirks: the trigger reads provider-reported `inputTokens`; local OpenAI-compatible
  servers that omit usage fall back to the char estimate (agent.ts ~line 585). The window size
  comes from `modelInfo(modelId).contextWindow` (models.dev data over the static table).
- Provider failover: the summary call must use the model that is actually serving requests, or it
  fails for the same reason the primary did.

## Design

### Trigger (agent.ts, `Agent.send` loop)

Every iteration of the tool loop starts with

```
if (shouldCompact(this.activeModelId, this.lastInputTokens)) {
  yield { type: "compaction", preTokens: this.lastInputTokens };
  await this.compactNow();
  this.lastInputTokens = 0;
  newMessages.length = 0;   // see "session file" below
}
```

`shouldCompact(modelId, lastInputTokens)` is `lastInputTokens > contextWindow * COMPACT_THRESHOLD`
with `COMPACT_THRESHOLD = 0.8`. `lastInputTokens` is set from the previous request's usage, so
compaction always runs *before* a request, never mid-stream, and the first request of a session
can never trigger it (the field starts at 0 and `clear()` resets it).

`compactNow()` does, in order:

1. Run the observational `compact:pre` lifecycle hook (if configured) with
   `{ preTokens, messages: this.messages.length }` on stdin. Its output is ignored.
2. `this.messages = await compact(this.activeModel, this.activeModelId, this.messages)`.
   `activeModel`/`activeModelId` are the failover-resolved model, not the primary.
3. `await this.opts.store?.rewrite(this.messages)` — the JSONL session file is rewritten
   wholesale (meta line kept) so disk matches memory.
4. `this.lastInputTokens = 0` so the stale pre-compaction usage cannot re-fire the trigger on the
   next iteration.

Session file bookkeeping: `send()` accumulates this turn's new messages in `newMessages` and
appends them in a `finally`. Because `rewrite()` already persisted them as part of the compacted
history, the loop empties `newMessages` after compaction; otherwise the finally block would append
them a second time and resurrect folded messages on resume.

### `/compact` (session-commands.ts `compactCommand`)

Shared by TUI (`App.tsx`) and REPL (`repl.ts`). Returns `{ message, contextTokens }`:

| Situation | message |
|---|---|
| `agent.history.length === 0` | `(nothing to compact — history is empty)` (no `compactNow` call) |
| `compactNow()` left the length unchanged | `(history is still small — nothing was summarized)` |
| otherwise | `(compacted <before> → <after> messages, ~<est> tokens of context)` |

`est` is `agent.estimateContextTokens()`. `/compact` bypasses the 80% test — it calls
`compactNow()` directly — but `compact()` itself still refuses histories that fit in the tail
budget (phase 2), which is what produces the "still small" message.

### `compact(model, modelId, messages)` — four phases (compact.ts)

Constants: `MIN_TAIL = 6`, `TAIL_BUDGET_FRACTION = 0.15`, `TAIL_BUDGET_CAP = 16_000`,
`SUMMARY_MIN_TOKENS = 1_000`, `SUMMARY_MAX_TOKENS = 4_000`, `SLIM_TOOL_CHARS = 800`,
`SLIM_TEXT_CHARS = 8_000`, `COMPACTION_MARKER = "[Conversation compacted. Summary of earlier context:]"`.

Early exits (return the same array, no LLM call): `messages.length <= MIN_TAIL + 2` (i.e. ≤ 8);
`cut <= 1` after phase 2 (everything fits in the tail); zero events after stripping a prior
summary.

**Phase 2 first — boundary (`tailBoundary`).** `tailBudget = min(contextWindow * 0.15, 16_000)`
estimated tokens (so any model with a window ≥ ~107k gets the 16k cap). Walk back from the end
adding `estTokens(m) = ceil(JSON.stringify(m).length / 4)`; stop when at least `MIN_TAIL`
messages are kept *and* the next one would exceed the budget. Then move `cut` further back while
`messages[cut].role === "tool"`, so the tail never opens with an orphaned tool result. Note the
walk-back loop counts `kept >= MIN_TAIL` before checking the budget, so the floor is honoured even
if six messages exceed the budget. Result: `head = messages[0..cut)`, `tail = messages[cut..]`.

**Prior-summary detection.** If `head[0]` is a `user` message whose string content starts with
`COMPACTION_MARKER`, the remainder (trimmed) is `prior` and `head[0]` is excluded from the events.

**Phase 1 — slim (`slimForSummary`)**, applied to the head only, for the summary prompt only (the
stored history is never mutated):

| Part | Rule |
|---|---|
| string message content > 8 000 chars | sliced to 8 000 + ` …[truncated]` |
| `text` part > 8 000 chars | same |
| `image` part | replaced by text `[image attached]` |
| `tool-call` whose `JSON.stringify(input)` > 800 chars | `input: { elided: "tool input elided (N chars)" }` |
| `tool-result` whose `output.value` string > 800 chars | first 400 chars + ` …[output elided (N chars)]` |

**Phase 3 — structured summary.** `summaryBudget = clamp(round(headTokens * 0.2), 1_000, 4_000)`
where `headTokens` is the estimated size of the slimmed events. One `generateText` call with
`maxOutputTokens: summaryBudget`, `system: SUMMARY_SYSTEM` (fixed sections: Goal / Constraints &
decisions / Done / In progress / Next steps; "be terse and concrete"; "when updating an existing
summary, fold new events into the sections"), and messages:

```
[ user: "Running summary from earlier compactions — merge into it, don't repeat it:\n\n<prior>" ]  (only if prior)
...slimmed events
user: "Produce the UPDATED running summary now — fold the events above into its sections, as instructed."
   or "Produce the summary now, as instructed."                                                   (no prior)
```

**Phase 4 — reassemble.** Return `[{ role: "user", content: "<MARKER>\n\n<text>" }, ...tail]`. The
tail is the original objects, verbatim and in order. The previous marker message is dropped, so
there is exactly one summary message in the history at any time, always at index 0 after a
compaction.

### Request-time pruning (`pruneOldToolResults`, agent.ts)

Independent of compaction and applied on **every** request inside `requestPrompt()` (before the
Anthropic cache breakpoints are added). For every message older than the last
`PRUNE_KEEP_TAIL = 20` with `role === "tool"`, any `tool-result` part whose `output.value` is a
string longer than `PRUNE_MIN_CHARS = 1500` is replaced with
`[old tool output elided (N chars) — re-run the tool if needed]`. Returns a new array; the stored
history and the session file keep the full outputs. Consequences: the provider-reported
`inputTokens` that drives `shouldCompact` already reflects pruning, and the summary call's events
do *not* (compaction reads `this.messages`, then slims independently with its own 800-char rule).

### Frontend surface

- `AgentEvent { type: "compaction", preTokens }` → TUI `compacted context · was <N> tokens`
  (info line); REPL `[compacting context — was N tokens]`; print mode ignores it.
- TUI status bar shows `ctx N%` from `estimateContextTokens()` and turns it red above 0.8 —
  purely a display of the same threshold, not a second trigger.
- `tui/run.tsx` scrollback replay skips user messages starting with `[Conversation compacted`
  (string literal, not the exported constant).

## Invariants

- Histories of ≤ 8 messages are returned as the same array with no LLM call — test/compact.test.ts
  "small histories are returned untouched without an LLM call".
- After compaction the history is `[marker summary, ...verbatim tail]`, the tail is the original
  trailing messages in order, and its size follows the token budget (~32 of 500-token messages
  under the 16k cap) — "folds the head into a marker summary and keeps a token-budgeted tail".
- The tail never starts with a `tool` message; a tool-call/result pair at the boundary survives
  whole — "the tail never starts inside a tool-call/result pair".
- A prior marker summary is fed back as the running summary ("merge into it"), the update prompt
  is used, and the old summary text is replaced rather than stacked — "re-compaction updates the
  prior summary instead of re-summarizing it".
- Tool outputs > 800 chars never reach the summarizer in full; real conversation text does —
  "bulky tool outputs are elided from the summarization prompt".
- Stored history is never mutated by slimming — implied by the "tail equals original slice" check
  above; the head-side non-mutation is untested.
- `pruneOldToolResults` elides only string outputs > 1500 chars outside the kept tail, leaves
  small outputs and the tail intact, and never mutates its input — test/reliability.test.ts
  "elides big old outputs, keeps the tail and small outputs intact".
- Conversations of ≤ `keepTail` messages pass through `pruneOldToolResults` as the same array —
  test/reliability.test.ts "short conversations pass through unchanged".
- Exactly one marker message exists after any number of compactions, at index 0 — untested
  directly (the re-compaction test checks content replacement, not count).
- `lastInputTokens` is reset to 0 after compaction so the trigger cannot re-fire on the next
  iteration — untested.
- After auto-compaction the session file equals the live history and this turn's messages are not
  appended twice — untested.
- The summary call uses the failover-active model, not the primary — untested.
- `compact:pre` runs before the summary call and its output cannot alter the result — untested.
- Summary output budget stays within 1k–4k tokens — untested (the mock model ignores
  `maxOutputTokens`).

## Acceptance criteria

1. `shouldCompact` is true iff `lastInputTokens > 0.8 * contextWindow` for the model — **gap**
   (no test imports `shouldCompact`).
2. Auto-compaction fires at the start of a send-loop iteration and emits `{ type: "compaction",
   preTokens }` before rewriting history — **gap**.
3. `compact()` on ≤ 8 messages returns the input untouched without calling the model —
   test/compact.test.ts "small histories are returned untouched without an LLM call".
4. `compact()` on a large history returns a `user` message starting with `COMPACTION_MARKER`
   followed by the model's text, then the verbatim tail — "folds the head into a marker summary…".
5. The tail is chosen by a 15%-of-window budget capped at 16k estimated tokens with a 6-message
   floor — "folds the head into a marker summary…" (checks 20 < tail < 40 for the capped case);
   the uncapped small-window case and the 6-message floor are **gap**.
6. The tail never begins with a `tool` message — "the tail never starts inside a
   tool-call/result pair".
7. In the summary prompt, tool outputs > 800 chars are cut to 400 chars plus an elision note —
   "bulky tool outputs are elided from the summarization prompt".
8. In the summary prompt, tool inputs > 800 chars, texts > 8 000 chars and images are replaced by
   stubs — **gap** (only tool outputs are exercised).
9. When `head[0]` is a marker summary, it is sent as the running summary with the merge
   instruction and the "UPDATED running summary" closing prompt, and the returned history contains
   only the new summary — "re-compaction updates the prior summary instead of re-summarizing it".
10. The summary call's `maxOutputTokens` is `clamp(0.2 * headTokens, 1000, 4000)` — **gap**.
11. `compactNow()` rewrites the session file with the compacted history and keeps the meta line —
    **gap** (`SessionStore.rewrite` has no direct test; see docs/specs/sessions.md).
12. After auto-compaction the turn's already-persisted messages are not appended again in the
    `finally` — **gap**.
13. `compactNow()` uses `activeModel`/`activeModelId` while failed over — **gap**.
14. `compact:pre` hook receives `{ preTokens, messages }` before the summary call — **gap**.
15. `/compact` on an empty history reports "nothing to compact" without calling `compactNow` —
    **gap**.
16. `/compact` reports "still small" when the length is unchanged and the
    `compacted a → b messages, ~N tokens` line otherwise — **gap**.
17. `pruneOldToolResults` elides string outputs > 1500 chars only in messages older than the last
    20, returns a new array, and leaves the input untouched — test/reliability.test.ts "elides big
    old outputs, keeps the tail and small outputs intact".
18. `pruneOldToolResults` returns the same array for histories of ≤ `keepTail` messages —
    test/reliability.test.ts "short conversations pass through unchanged".
19. Pruning is applied to every request prompt (`requestPrompt`) but never to stored history —
    **gap** (only the pure function is tested).
20. The TUI shows `compacted context · was N tokens` and the REPL `[compacting context — was N
    tokens]` on the event — **gap**.

Total: 20 criteria, 13 gaps (1, 2, 5 partial, 8, 10, 11, 12, 13, 14, 15, 16, 19, 20).

## Open questions / known gaps

- The trigger depends on provider-reported `inputTokens`. Providers that omit usage get the
  ~4 chars/token estimate of the *unpruned* history (`estimateContextTokens`), which overstates
  the real request and can compact early; whether this matters in practice is unmeasured.
- `MIN_TAIL = 6` is an absolute floor: if six trailing messages exceed the tail budget (e.g. a
  huge single tool result), the tail overshoots 15% and the very next request can still be over
  the window. Nothing loops or errors; the model simply gets a too-large request. Unhandled.
- The summary call itself can fail (rate limit, outage). `compactNow()` does not catch it; in the
  send loop the error propagates as a turn error, and `/compact` surfaces it as "compact failed:
  …" (repl.ts) — the history is left unchanged in both cases. There is no retry or failover
  walk specifically for the summary call.
- If the summarizer ignores the section format, the marker still wraps whatever it returned; no
  validation. The iterative-update quality across many rounds is asserted only structurally
  (prompt contents), not semantically.
- `tui/run.tsx` matches the marker with a hardcoded `"[Conversation compacted"` prefix instead of
  importing `COMPACTION_MARKER`; a marker change would silently break scrollback filtering.
- `pruneOldToolResults` and `slimForSummary` use different thresholds (1500 vs 800 chars) and
  keep different stubs; both are tuned by hand, neither by measurement.
- `/compact` does not emit the `compaction` event, so hooks see `compact:pre` but the frontend
  prints only the command result string.
- Most of the agent-level wiring (criteria 1–2, 11–16, 19–20) is untested; the unit under test
  is the pure `compact()` function and the pure `pruneOldToolResults`.

## Decisions

- 2026-07-22 (v0.0.13, c383511) — `/compact` and `/clear` became "honest": they rewrite the
  session file and reset `lastInputTokens`, instead of only editing memory, so resume and the
  context meter reflect what actually happened.
- 2026-07-22 (v0.0.27, 7ede145) — request-time pruning added (`pruneOldToolResults`, 20-message
  tail, 1500-char threshold) as cheap hygiene independent of compaction, on the reasoning that stale
  file dumps are the main context hog and the model can always re-run a tool.
- 2026-07-2x (v0.0.46, 388bf17) — after auto-compaction the turn's `newMessages` buffer is cleared
  so the `finally` append does not duplicate and resurrect folded messages in the session file.
- 2026-07-23 (v0.0.93, cdd4a7c) — replaced the original summarize-and-truncate design (fixed
  `KEEP_TAIL = 4`, one free-form summary prompt, no memory of earlier summaries) with the
  Hermes-style four-phase design: token-budgeted tail with a 6-message floor over a fixed count,
  slimming of the head before the summary call, fixed summary sections with a proportional output
  budget, and iterative update of the prior summary over re-summarizing a summary. The commit
  message and the module comment cite decay across repeated compactions as the motivating problem.
- 2026-07 (v0.0.93, docs) — no mid-task "context is getting full" warning is ever injected; the
  Hermes finding cited in docs/compaction.md is that such warnings make models give up early.
  Compaction fires silently apart from the one-line frontend notice.
- 2026-07/08 (v0.0.101, d0832cd) — the summary call moved from the primary model to
  `activeModel`/`activeModelId`, because during failover the primary cannot serve the summary
  request either.
- 2026-08 (v0.0.111, 40887ec) — `compact:pre` added as an observational lifecycle hook (payload
  `{ preTokens, messages }`); it cannot veto or alter compaction.
- Undated — the summary is stored as a `user` message rather than a `system` message, so it
  survives the Anthropic system-as-message caching path and any provider that rejects multiple
  system messages; the reason is not recorded in code comments (inferred from `requestPrompt`).
