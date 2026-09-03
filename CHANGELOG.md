# Changelog

Aerin is developed *with* aerin-style agents: the overwhelming majority of the code since v0.0.90 was written by a coding agent under human direction. We report it per release, Aider-style.

## Unreleased
- **TUI polish**: the input box no longer defaults to a green border/prompt (green now only signals plan/accept/working states); your own messages in the transcript render bold white instead of green, closer to how Claude Code highlights your turns; multi-line messages you send now indent continuation lines under the `❯` marker instead of running flush left, matching how the agent's own replies already align under `●`; fixed a cursor/placeholder off-by-one that put two spaces before the empty-input hint instead of one.
- **OpenCode Zen + direct Nemotron/MiMo/Muse**: curated `opencode` entry (OpenCode's own hosted model gateway) — dozens of models, several genuinely $0/$0-priced ("-free" ids), including free-tier Nemotron, Ling/Ring (InclusionAI/Ant), MiMo, and Muse variants, verified against live per-model pricing rather than a provider-wide flag. Also added direct vendor entries: `nvidia` (NVIDIA NIM, Nemotron), `xiaomi` (MiMo), `meta` (Muse).
- Fix: Google's model list no longer surfaces `computer-use-preview`/`antigravity-preview` — both list under `generateContent` but reject a real chat turn (zero free quota / "multiturn chat not enabled"), so they were unusable dead ends in the picker regardless of tier.
- Zero-key onboarding message now points at OpenCode Zen alongside Ollama as a way to get free models without a local install.
- **Non-chat models filtered everywhere, not just Google/OpenAI**: a shared name-based filter (embeddings, rerankers, moderation/safety, audio/speech/voice, image/video generation, realtime) now applies to every provider's model list, including xAI, Anthropic, OpenRouter, Ollama, and any custom endpoint — previously only OpenAI and Google had hand-rolled versions of this. Fixes xAI's `grok-imagine-image`/`grok-imagine-video` (and similar) cluttering the picker with models that can't drive the agent.
- **GLM China endpoint + AiHubMix**: `zhipuai-cn` (bigmodel.cn, same models as the existing `zai`/z.ai entry, aliased for shared pricing — Zhipu's own registry lists `glm-4.5-flash`/`glm-4.7-flash` as genuinely free) and `aihubmix` (aggregator with its own published free-models page).
- **Model picker "Recommended" section**: up to 2 small/fast models per connected provider (`isSmallModel` — a name heuristic: mini/flash/lite/nano/small/haiku/turbo/fast, or a 1-9B parameter count) surface above the full per-provider list, so `/model` doesn't dump every model from every connected provider before you can find a quick default. The full list is still there below, ungated — this only reorders what's on top.

## 0.0.117 — 2026-09-03
*(0.0.116 got stuck mid-publish on the npm registry — accepted but never finalized — and is skipped; same content ships here.)*
- **Jade theme, deepened**: the initial rebrand read as bright mint; the accent/hero greens are now a deeper, more saturated jade, secondary text and code-accent tones dropped their green cast for true neutral gray/white, and the startup banner + wordmark now fade toward near-black instead of staying pastel.
- **Jade theme, on real colors**: swapped the invented accent/hero hexes for verifiable named colors — Emerald `#50c878` (the gemstone's canonical hex) as the interactive accent, Dark Jade `#007a54` as the hero, and traditional pigment Emerald Green `#046307` anchoring the deep end of every gradient; success and the plan-mode/headers tone are the standard CSS greens MediumSeaGreen and SeaGreen.

## 0.0.115 — 2026-09-03
- **Custom provider protocol + headers**: `providers.<name>.protocol` (`"openai"` default | `"anthropic"`) lets a custom `baseURL` entry speak the Anthropic Messages API instead of OpenAI-compatible; `providers.<name>.headers` adds arbitrary request headers for gateways that don't authenticate with a plain Bearer key. Wired through `/connect` (both TUI wizard and REPL) and model listing.
- **More curated providers, Chinese platforms included**: Alibaba Cloud (Qwen, intl + China), SiliconFlow (intl + China), Volcengine Ark (ByteDance/Doubao), StepFun, SenseNova, Tencent Hunyuan, MiniMax (its first Anthropic-protocol curated entry), plus Novita AI, Nebius, Baseten, Friendli, Upstage, and a `vllm` preset. `/connect`'s dynamic models.dev list now also surfaces Anthropic-protocol registry entries (previously OpenAI-compatible only), so a provider on either protocol appears without an aerin code change.
- **Jade theme**: retired the pink-red/magenta "Pop N' Lock" look for a black/white/emerald palette (`src/tui/theme.ts` — the one-file retheme point), including the startup banner gradient, wordmark SVG, and README badge. Red/amber stay as functional error/warning colors.
- Fix: a turn error surfaced after failover was attributed to the primary model instead of the fallback that actually raised it, so the remediation hint (e.g. "fix your API key") pointed at the wrong provider (#13).

## 0.0.113 — 2026-07-23
- Colorful centered AERIN wordmark (the app's SUNSET palette) as an SVG in the README.

## 0.0.111 – 0.0.112
- **Lifecycle hook events**: `session:start` (context → system prompt), `prompt:submit` (veto/enrich), `turn:end` (a stop-gate that can demand more work, capped 3×/turn), `compact:pre`, `session:end` — same config map and JSON protocol as tool hooks.
- README restyled: wordmark header, badges, features linking into the docs knowledge base.

## 0.0.108 – 0.0.110
- **Bounded memory**: `## Memory` in AGENTS.md under a hard 2,500-char budget with `add`/`replace`/`remove`; a full memory refuses adds and instructs consolidate-then-retry.
- Wheel-as-arrow bursts scroll the transcript instead of cycling input history.
- `/clear` drops the goal and disarms the goal loop.

## 0.0.104 – 0.0.107
- **Doom-loop breaker**: the 4th byte-identical tool call raises a permission ask before more tokens burn.
- **Spill files**: truncated tool output saved in full with a grep/read-slices hint.
- `docs/` knowledge base: one page per feature, indexed, linked from AGENTS.md and CLAUDE.md.
- Slash-command suggestions render above the input bar; terminal fully restored (cursor, raw mode) on every exit path.

## 0.0.103 — autonomous /goal loop
- `/goal <text>` works until an evidence-based completion judge (cheap model, fail-open, 20-turn budget) sees it done.

## 0.0.100 – 0.0.102
- **Deferred MCP tools**: `tool_search`/`tool_describe`/`tool_call` bridges when schemas would eat >10% of context; permissions apply to the real tool through the bridge.
- **Provider failover**: `fallbackModels` chains take over mid-turn on rate limits, outages, spent quotas — never on auth errors.
- **JSON hooks protocol**: pre-hooks can allow/deny/ask and rewrite input (re-checked against deny rules); post-hooks inject context; legacy exit-code hooks unchanged.

## 0.0.97 – 0.0.99
- **Worker sub-agents** (`mode:"worker"`): write/edit/bash under the parent's policy, serialized permission asks, writes covered by the parent's undo snapshot, no recursion.
- **Post-edit diagnostics**: the project's typecheck runs after every write/edit and failures feed back; auto-detected from package.json.

## 0.0.90 – 0.0.95
- **Shadow-git undo/redo**: `/undo` covers bash side effects via a shadow repo; `/redo` walks forward.
- **Session search**: episodic recall over the project's past conversations.
- **Permission deny rules**: beat allow/accept/`--yolo`, match chained bash segments.
- **Hermes-style compaction**: token-budgeted protected tail + an iteratively *updated* structured summary.
- **Per-model-family prompts**: GPT/Gemini/open-model addenda resolved at request time.

*(Earlier releases predate this changelog; see git history.)*
