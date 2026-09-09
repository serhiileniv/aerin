# Spec: Provider failover chains

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/provider-failover.md · Source: src/core/agent.ts (`isRetryableError`, `isFailoverEligible`, `enrichProviderError`, `advanceFailover`, `activeModel`/`activeModelId`, `setModel`, the retry loop in `send()`), src/cli.ts (`fallbacks` wiring), src/config/config.ts (`fallbackModels`), src/core/events.ts (`failover`, `retry` events) · Tests: test/failover.test.ts, test/reliability.test.ts

## Goal

A turn should survive the active provider being rate-limited, overloaded, down, or out of quota.
The user lists an ordered chain in config (`"fallbackModels": ["provider/model", …]`); when the
active model fails in a way another provider could serve, the agent switches to the next usable entry
and finishes the turn there, telling the user what happened. "Done" means the turn completes on a
fallback with no `error` event, every hop is visible in every frontend, an exhausted chain surfaces
the real error attributed to the model that raised it, and the next turn tries the primary again.

## Non-goals

- Not a load balancer or cost router: the chain is strictly ordered and only consulted on failure.
- Not persistent health tracking: nothing remembers that a provider failed last turn.
- Not a fix for authentication or validation errors — those need the user (`/connect`), and failing
  over would silently spend money on another provider.
- Does not retry once content has streamed; a stream that dies mid-answer fails honestly.
- Sub-agents and the goal judge have no chain (see known gaps).

## Constraints

- `src/` line budget: the feature is ~60 lines in `agent.ts` plus ~10 in `cli.ts`.
- Layering: all failover logic lives in core; frontends only render the `failover` event.
- Provider quirks: errors arrive as `APICallError`, plain `Error`, strings, or bare objects — every
  classifier goes through `errorMessage()` first.
- Fallback entries must resolve lazily: a chain entry whose provider has no key must not break startup.

## Design

### Configuration → `AgentOptions.fallbacks`

`configSchema.fallbackModels: z.array(z.string()).optional()`. `loadConfig` takes the project value
when present, else the global one (whole-array override, not a merge). In `setupAgent`, a non-empty
list becomes

```
fallbacks: config.fallbackModels.map((id) => ({ modelId: id, resolve: () => resolveModel(id, config) }))
```

`resolve` is a thunk so a missing key surfaces only when the entry is reached.

### Agent state

```
private failover: { model: LanguageModel; modelId: string } | undefined;   // set while failed over
private failoverIndex = 0;                                                // next chain entry to try
private get activeModel()   { return this.failover?.model   ?? this.opts.model; }
private get activeModelId() { return this.failover?.modelId ?? this.opts.modelId; }
```

`advanceFailover()` walks `opts.fallbacks` from `failoverIndex`: entries equal to the current
`activeModelId` are skipped; `resolve()` throwing (no key, bad id) skips to the next; the first
success sets `this.failover` and returns it; running off the end returns `undefined`. The index only
moves forward, so an entry that failed is never retried within the turn.

### Error classification

- `isRetryableError(err)`: returns `false` first for quota shapes
  (`/per.day|daily|quota|insufficient.credit|billing|payment/`); then `true` for
  `APICallError.isRetryable`, status codes `408 409 429 500 502 503 529`, message patterns
  `/overloaded|rate.?limit|too many requests|timed? ?out|econnreset|econnrefused|fetch failed|socket|network error/`,
  or a bare `429|500|502|503|529` token in the message.
- `isFailoverEligible(err)`: `isRetryableError(err)` **or**
  `/per.day|daily|quota|insufficient.credit|billing|payment|overloaded/`. Auth (`401`, "invalid api
  key"), validation, and unknown errors are ineligible.
- `enrichProviderError(modelId, message)` → `[${modelId}] ${message}${hint}` where the hint is one
  of: `check your <provider> key: /connect <provider>` (auth), `<provider> quota or billing limit;
  try another model (/model)`, `<provider> rate limit; wait a moment or switch models (/model)`,
  `this model cannot work as a coding agent…`, `that model id may be wrong or retired…`, or none.

### The retry/failover loop (inside `send()`, per tool-loop iteration)

```
failover = undefined; failoverIndex = 0            // at the top of every send()
for (attempt = 0; ; attempt++):
  result = streamText({ model: activeModel, ...requestPrompt(), tools, abortSignal, onError: () => {} })
  received = false
  try: for await part of result.fullStream: received = true on any content part; throw on part.type === "error"
       break
  catch err:
    if received || aborted: throw err                                   // fail honestly
    if attempt >= MAX_STREAM_RETRIES (2) || !isRetryableError(err):
      from = activeModelId
      if isFailoverEligible(err) && advanceFailover():
        toolCalls.length = 0
        yield { type: "failover", from, to: activeModelId, message: errorMessage(err).slice(0, 200) }
        attempt = -1                                                    // fresh retry budget
        continue
      throw err
    toolCalls.length = 0
    yield { type: "retry", attempt: attempt + 1, maxAttempts: 3, message }
    await sleep(1500 * (attempt + 1))                                   // abortable
```

Consequences: a retryable error gets up to three attempts on the same model (attempt 0–2) before the
chain is consulted; a quota/billing error is not retryable, so the chain is consulted on the first
failure; each fallback gets its own three attempts. The thrown error reaches `send()`'s catch, which
yields `{ type: "error", message: enrichProviderError(this.activeModelId, errorMessage(err)) }` — the
**active** id, i.e. the fallback that actually failed when the chain is exhausted.

### Identity follows the active model

Everything model-dependent inside a turn reads `activeModel`/`activeModelId`, never `opts.*`:
`requestPrompt()` (Anthropic cache breakpoints keyed on the `anthropic/` prefix),
`effectiveSystemPrompt()` ([family guidance](model-families.md)), `estimateCostUsd(activeModelId, …)`,
`shouldCompact(activeModelId, …)`, `compactNow()` (summary call on `activeModel`), and
`judgeModel()`'s fallback. `agent.modelId`/`agent.model` (public getters) still return the primary.

### Reset

`send()` clears `failover`/`failoverIndex` at the top of every turn — each turn re-probes the primary.
`setModel()` also clears both: a deliberate `/model` switch supersedes any failover.

### Rendering

`AgentEvent` `{ type: "failover"; from; to; message }`. TUI (`App.tsx`) pushes an info line
`failover · <from> → <to> · <message.slice(0,80)>`; print mode's `diagnostic()` writes
`[failover] <from> -> <to>: <message.slice(0,120)>` to stderr; the REPL imports `diagnostic()` from
`modes/print.ts` for the same text.

## Invariants

- Quota/billing and retryable errors are failover-eligible; auth errors are not —
  `test/failover.test.ts` ("isFailoverEligible").
- Quota errors are never retried in place (no backoff delay) — `test/reliability.test.ts`
  ("isRetryableError": not retryable for auth/validation) and implicitly `test/failover.test.ts`
  (the quota tests run without delays); the "no delay" property itself is untested.
- A fallback whose `resolve()` throws is skipped, and a fallback that also fails advances the chain
  in order — `test/failover.test.ts` ("unresolvable and equally-broken fallbacks are walked past").
- When the chain is exhausted, the surfaced error names the model that raised it and its provider's
  remediation, not the primary's — `test/failover.test.ts` ("blames the fallback that actually failed").
- No failover for ineligible errors, even with a working fallback configured —
  `test/failover.test.ts` ("ineligible errors never fail over").
- Failover state never outlives a turn; `setModel` clears it — untested.
- `this.messages` is not touched by a model change; the new model sees the full history —
  `test/failover.test.ts` ("the new model receives the full prior conversation").
- Once any content part has arrived, a stream error is thrown rather than retried — untested.

## Acceptance criteria

1. `isFailoverEligible` is true for `429`, "daily quota", "insufficient credit/billing" and false
   for "Invalid API key" — test/failover.test.ts.
2. A spent-quota primary fails over immediately; the turn completes on the fallback with a
   `failover` event `{from: primary, to: fallback}` and no `error` event — test/failover.test.ts.
3. Chain walk skips entries whose `resolve()` throws and continues past fallbacks that fail
   themselves, emitting one `failover` event per successful hop — test/failover.test.ts.
4. An exhausted chain yields exactly the failover events that happened plus one `error` carrying
   the last model's message — test/failover.test.ts.
5. The exhausted-chain error is labelled `[<fallback id>]` with `/connect <fallback provider>`, and
   never mentions the primary — test/failover.test.ts.
6. Auth errors on the primary produce an `error` and no `failover` — test/failover.test.ts.
7. `isRetryableError` classifies rate limit / overload / network as retryable and auth /
   not-found / validation as not — test/reliability.test.ts.
8. `enrichProviderError` produces the auth, rate-limit, billing, tool-unsupported hints and the bare
   `[model] message` form — test/reliability.test.ts.
9. A retryable error is retried up to `MAX_STREAM_RETRIES` times with `retry` events and growing
   backoff before the chain is consulted — **gap**.
10. A fallback model gets a fresh retry budget (`attempt = -1`) — **gap**.
11. The next `send()` starts on the primary again — **gap**.
12. `setModel` while failed over clears failover state — **gap**.
13. Cost, compaction threshold, cache breakpoints and family guidance use the fallback while active —
    **gap**.
14. `fallbackModels` parses from config and project overrides global — **gap** (test/config.test.ts
    has no `fallbackModels` case).
15. `failover` is rendered by TUI, REPL and print mode — **gap** (no frontend test).

## Open questions / known gaps

- Sub-agents (`tools/agent-tool.ts`) construct `Agent` without `fallbacks`, and the goal judge uses
  `getJudgeModel` with a plain fallback to `activeModel` — neither gets a chain.
- Failover is only attempted when the stream fails **before** any content; a provider that dies
  mid-answer surfaces an error even with a healthy fallback.
- `usage` events after a hop carry no model id, so per-model cost attribution within a turn is lost
  (totals are correct because `estimateCostUsd` uses `activeModelId`).
- The `/status` line and the TUI header show the configured model, not the active fallback.
- The eligibility regexes are substring heuristics; an unusual provider message ("credits") would be
  neither retried nor failed over.
- `advanceFailover` never revisits an entry within a turn, so a chain `[B, C]` where B rate-limits
  briefly will finish on C even if B recovers seconds later (by design, untested).

## Decisions

- 2026-07-23 (d0832cd, v0.0.101): implement failover inside `Agent.send()` rather than in a provider
  wrapper, so every frontend and the cost/compaction/caching paths see one `activeModel` and the
  event stream stays the only core↔UI contract.
- 2026-07-23 (d0832cd): quota/billing errors are fail-fast (excluded from `isRetryableError`) yet
  failover-eligible — retrying the same provider "just wastes a minute" (source comment), while a
  different provider can serve immediately.
- 2026-07-23 (d0832cd): auth/validation errors are never failed over — they need the user, and
  silently spending on another provider would hide the real problem.
- 2026-07-23 (d0832cd): lazy `resolve()` thunks over eager model construction, so a chain entry with
  no key is skipped at failover time instead of crashing startup.
- 2026-07-23 (d0832cd): failover state resets every turn ("each send re-probes the primary once")
  instead of sticking — the primary is the user's choice and outages are usually short.
- 2026-08-07 (1c89554, #13): surfaced errors are attributed to `activeModelId`, not `opts.modelId` —
  a bug had sent users to fix the primary's key when the fallback had failed.
- 2026-09-03 (8146cb6): added a regression test that a `/model` switch keeps the full conversation,
  after the docs claimed it and nothing guarded it.
