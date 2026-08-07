# Provider failover

Source: `src/core/agent.ts` (`isFailoverEligible`, `advanceFailover`, the retry loop in `send()`).

Config `"fallbackModels": ["provider/model", ...]` is an ordered chain tried when the active model fails mid-turn — the turn continues instead of dying.

## Triggers
- Retryable errors (rate limit, 5xx, overload, network) after the 2 in-place retries are exhausted.
- Fail-fast **quota/billing** errors immediately — retrying the same provider is pointless, but a different provider can serve; that's exactly what a chain is for.
- **Never on auth errors**: a bad key needs the user, and silently spending money elsewhere would be the wrong fix.

## Chain walk
Entries resolve lazily — a fallback with no configured key is skipped; a fallback that also fails advances to the next; each new model gets a fresh retry budget; when the chain runs dry the real error surfaces, attributed to the model that actually raised it. Every hop emits a `failover` event rendered in all frontends.

## Identity follows the active model
Per-family prompt tuning, Anthropic cache breakpoints, cost estimation, compaction thresholds, the compaction summary call, and the `[model]` label plus remediation hint on a surfaced error all switch to the fallback while it's active (if the primary is down, compacting through it would fail too).

## Self-healing
Failover state resets every turn — each send re-probes the primary once — and on any `/model` switch.
