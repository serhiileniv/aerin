# Per-model-family prompts

Source: `modelFamily` / `modelFamilyGuidance` in `src/core/system-prompt.ts`, applied in `Agent.effectiveSystemPrompt()`.

Aerin keeps one shared base system prompt (written against Claude) and appends a short **family addendum** targeting each family's known failure modes — instead of maintaining five duplicated prompt files.

## Families
- **claude** — no addendum; the base prompt is its tuning.
- **gpt** (gpt-*/o-series/codex, token-wise matched so `grok` can't false-positive) — persistence ("never end having only announced what you will do"), no confirmation-seeking, no reconstructing file contents from memory, short final messages.
- **gemini** (incl. gemma) — smallest-change discipline, "invoke tools through tool calls, never print a code block describing one", re-read-then-rebuild after two failed edit matches, no apology loops.
- **other** (qwen, deepseek, kimi, llama, grok, local models…) — exact-match edit discipline, one tool call at a time unless clearly independent, never fabricate results, small verified edits.

## The wiring detail that matters
The addendum is resolved **at request time** from the current model id — not baked in at startup. So `/model` switches swap the guidance with the model, [provider failover](provider-failover.md) gets the fallback's guidance mid-turn, and sub-agents on a cheaper `subagentModel` get guidance for *their* model, not the parent's.

## What a `/model` switch does and doesn't touch
`Agent.setModel()` (`src/core/agent.ts`) only replaces which model the next turn calls — it never touches `this.messages`. The full conversation history rides along unchanged, so the new model gets it as context on its very next turn, same as everything else that's model-dependent (family guidance above, cache breakpoints, cost estimation, the compaction threshold) since those all read the *current* active model, not the one the session started with.
