# Spec: Model families — per-family system-prompt addenda

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/model-families.md · Source: src/core/system-prompt.ts (`modelFamily`, `FAMILY_GUIDANCE`, `modelFamilyGuidance`), src/core/agent.ts (`effectiveSystemPrompt`, `activeModelId`, `setModel`) · Tests: test/family-prompt.test.ts, test/failover.test.ts (model-switch continuity), test/tool-progress.test.ts (system prompt reaches the request)

## Goal

Aerin's base system prompt was written and tuned against Claude. Other model families fail in
predictable, family-specific ways (GPT stops after announcing a plan, Gemini prints tool calls as
code blocks, small open models reconstruct file contents from memory). The feature appends a short
addendum for the family of the model that will actually serve the request, so one shared base prompt
covers every provider without five diverging prompt files. "Done" means: the addendum is always the
one for the currently active model — after `/model`, mid-turn failover, and inside sub-agents — with
no addendum at all for Claude.

## Non-goals

- Not a per-model prompt system: there are exactly four families (`claude`, `gpt`, `gemini`, `other`)
  and no per-model overrides. Provider-specific wire quirks live in `providers/registry.ts`.
- Not a capability check: whether a model can drive tools at all is `ModelInfo.toolCall`
  (`providers/models.ts`) and the picker filter in `providers/list-models.ts`.
- No user-configurable guidance text; the addenda are constants in source.
- Does not rewrite the base prompt's `Model: <id>` environment line (see known gaps).

## Constraints

- `src/` stays under 10,000 lines (CI): the whole feature is ~35 lines of source plus one call site.
- Layering rule: `system-prompt.ts` and `agent.ts` are core; nothing here imports UI.
- Must be provider-agnostic: family is inferred from the model id string only, never from the
  provider prefix (OpenRouter serves Claude, Ollama serves Gemma, etc.).
- No new dependencies.

## Design

### Family detection — `modelFamily(modelId): ModelFamily`

`export type ModelFamily = "claude" | "gpt" | "gemini" | "other"`. The id is lowercased and tested in
this order:

1. `id.includes("claude")` → `"claude"` (so `openrouter/anthropic/claude-sonnet-5` is Claude).
2. `id.includes("gemini") || id.includes("gemma")` → `"gemini"`.
3. Token-wise GPT check: `id.split(/[^a-z0-9.]+/)` and any token that `startsWith("gpt")`,
   `startsWith("codex")`, or matches `/^o\d+$/` → `"gpt"`. Tokenising (rather than substring
   matching) is what keeps `xai/grok-4` out of the o-series bucket — the code comment names `grok`
   as the false positive being avoided.
4. Everything else → `"other"` (qwen, deepseek, kimi, llama, mistral, grok, local models).

Steps 1–2 are substring checks and run before step 3, so an id containing both `claude` and `gpt`
would resolve to `claude`; no such id is known.

### Guidance table — `FAMILY_GUIDANCE: Record<ModelFamily, string>`

| Family | Addendum |
|---|---|
| `claude` | `""` — the base prompt is its tuning. |
| `gpt` | Header `Model-specific guidance (GPT family):` + 4 bullets: keep working until resolved / never end having only announced; no confirmation-seeking for reversible in-scope actions; never reconstruct file contents or command output from memory; short final message, no headers/recaps/next-step offers. |
| `gemini` | Header `Model-specific guidance (Gemini family):` + 4 bullets: smallest change that satisfies the task; always invoke tools through tool calls, never print a code block/JSON describing one; after two failed edit matches re-read and rebuild; no apology loops. |
| `other` | Header `Model-specific guidance:` + 5 bullets: edit tool needs an EXACT match (read first, copy verbatim); one tool call at a time unless clearly independent; never fabricate a tool result; small verified edits over rewrites; if a tool errors twice, stop and reconsider. |

`modelFamilyGuidance(modelId)` is `FAMILY_GUIDANCE[modelFamily(modelId)]`.

### Wiring — resolved per request, not at startup

`buildSystemPrompt()` (cli.ts, once per session) produces the base prompt and does **not** include
any family text. The addendum is attached by `Agent.effectiveSystemPrompt()`:

```
effectiveSystemPrompt():
  tuning = modelFamilyGuidance(this.activeModelId)
  base   = tuning ? `${opts.systemPrompt}\n\n${tuning}` : opts.systemPrompt
  return goal ? `${base}\n\nSession goal (set by the user — keep every action pointed at it):\n${goal}` : base
```

`requestPrompt()` calls this on every `streamText` invocation (every iteration of the tool loop), so
the addendum follows whatever `activeModelId` is at that moment:

- `activeModelId` = `this.failover?.modelId ?? this.opts.modelId` — after a mid-turn
  [failover](provider-failover.md) the fallback's family guidance is used for the rest of the turn.
- `/model` → `Agent.setModel(model, modelId)` replaces `opts.model`/`opts.modelId` and clears
  failover state; `this.messages` is untouched, so the next request carries the full history plus
  the new family's addendum.
- Sub-agents (`tools/agent-tool.ts`) construct their own `Agent` with their own `modelId` (the
  `subagentModel` when configured, or a named agent's `model`), so the same method resolves guidance
  for the sub-agent's model, not the parent's.

Order inside the final prompt: base prompt → family addendum → session goal. For Anthropic ids the
whole string becomes the cache-controlled `system` message (see `requestPrompt`); for others it is
the plain `system` option.

## Invariants

- `modelFamilyGuidance("…claude…")` is the empty string, and an empty addendum adds no separator to
  the base prompt — `test/family-prompt.test.ts` ("claude gets no addendum") guards the first half;
  the no-separator half is untested.
- Family detection ignores the provider prefix (`anthropic/`, `openrouter/anthropic/`, `ollama/`) —
  `test/family-prompt.test.ts` ("claude ids, wherever the provider serves them from", "gemini family
  includes gemma").
- GPT detection is token-wise: `grok` never matches the o-series rule — `test/family-prompt.test.ts`
  ("everything else is other — no substring false positives").
- The three non-Claude addenda are non-empty (>50 chars) and pairwise distinct —
  `test/family-prompt.test.ts` ("other families get distinct non-empty guidance").
- `opts.systemPrompt` is never mutated; the addendum is recomputed from `activeModelId` on every
  request — untested (no test inspects the outgoing system prompt across a model switch).
- The session goal, when set, is appended after the family addendum — `test/tool-progress.test.ts`
  ("a pinned goal reaches the system prompt") checks presence, not ordering.

## Acceptance criteria

1. `modelFamily` returns `claude` for any id containing `claude`, regardless of provider path —
   test/family-prompt.test.ts.
2. `modelFamily` returns `gpt` for `gpt-*`, `o<digits>` and `codex*` tokens, including nested
   OpenRouter ids — test/family-prompt.test.ts.
3. `modelFamily` returns `gemini` for `gemini*` and `gemma*` — test/family-prompt.test.ts.
4. `modelFamily` returns `other` for grok, qwen, deepseek, kimi, mistral — test/family-prompt.test.ts.
5. Claude gets an empty addendum — test/family-prompt.test.ts.
6. GPT, Gemini and other addenda are non-empty, distinct, and carry their family header —
   test/family-prompt.test.ts.
7. After `setModel`, the very next request's system prompt carries the new family's addendum —
   **gap** (test/failover.test.ts "manual /model switch" proves history continuity only).
8. After a mid-turn failover, the remaining requests of that turn use the fallback's addendum —
   **gap**.
9. A sub-agent on `subagentModel` gets guidance for its own model — **gap**.
10. The session goal is appended to the system prompt when set and absent when cleared —
    test/tool-progress.test.ts.

## Open questions / known gaps

- The base prompt's `Environment` block embeds `Model: ${modelId}` at startup and is never rebuilt;
  after `/model` or failover the model tells itself the wrong id while receiving the right addendum.
- Family detection is a string heuristic. Ids like `ollama/gpt-oss:20b` land in `gpt` (intended);
  a hypothetical provider id containing `gemma` as part of another word would land in `gemini`.
- No integration test drives `Agent` and asserts the outgoing `system` text contains the addendum
  (criteria 7–9). The `mock/mock` id used across tests resolves to `other`, so every Agent test
  silently exercises the `other` addendum without asserting on it.
- The addenda have not been evaluated against the families they target beyond the author's
  observation of failure modes; there is no eval harness.

## Decisions

- 2026-07-23 (28e4a04, v0.0.95): one shared base prompt plus a small per-family addendum, over
  opencode's approach of one full prompt file per family — the base prompt was already a large,
  carefully ordered document and duplicating it five times would drift immediately and cost lines
  under the 10k budget.
- 2026-07-23 (28e4a04): resolve the addendum at request time in `Agent.effectiveSystemPrompt()`
  rather than baking it into `buildSystemPrompt()`, so `/model`, failover and sub-agents pick the
  right guidance without the caller rebuilding the prompt (source comment in system-prompt.ts).
- 2026-07-23 (28e4a04): token-wise matching for the GPT family after `grok` was observed to match a
  naive `o*` substring rule (source comment).
- 2026-07-23 (28e4a04): Gemma folded into the Gemini family — same vendor, same failure modes.
- 2026-07-23 (28e4a04): Claude gets no addendum by design — the base prompt is its tuning; adding
  Claude-specific text would double up instructions already present.
