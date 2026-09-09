# Changelog

Aerin is developed *with* aerin-style agents: the overwhelming majority of the code since v0.0.90 was written by a coding agent under human direction. We report it per release, Aider-style.

## 0.0.121 — 2026-09-09
- **Fixed: the turn receipt floated below the reply**: `⎿ done · 17s · …` was pushed as its own line after the block gap, so it read as detached; it now hangs directly under the reply (or the last tool block) and survives a resize re-render.
- **Fixed: `ctrl+o` output landed at the bottom of the transcript**: the expanded output now replaces the collapsed line inside the tool block it belongs to (`● List(.)` → its full output), instead of hanging under whatever came last.
- **Fixed: footer showed `ctx 0%` with thousands of tokens in**: on large-context models the percentage rounded to zero; it now shows `<1%`.

## 0.0.120 — 2026-09-09
- **Scheduling through `every`, never cron**: new `schedule` tool drives [`every`](https://github.com/serhiileniv/every) (launchd / systemd user timers / Task Scheduler, with run history). list/inspect/log/doctor are read-tier; add/run/pause/resume/remove are execute-tier via the new per-call `ToolDef.tierFor`, so rules like `schedule(add *)` and deny `schedule(remove backup*)` work. The system prompt forbids crontab/plists/timer units; `aerin doctor` reports whether `every` is installed.
- **`/loop <when> <prompt>`**: run a prompt on a schedule outside the session — each firing is a fresh headless `aerin -p --output-format text --prompt-file …` run registered with `every set`, so it outlives the terminal and has a log. `every`'s grammar is parsed off the front of the prompt (`15m`, `day 9am,6pm`, `weekdays 9:30`, `monday,thursday 6pm`, `monthly 1st 9am`, `once tomorrow 9am`); `--name`, `--timeout` (default 10m), `--yolo`; `/loop` lists, `/loop log|run|stop <name>` manage. The prompt lives in a file, so no shell quoting on any platform.
- **Headless output formats**: `aerin -p --output-format text` (default) streams the reply with exactly one newline per message and at the end; `--output-format json` prints one object (result, isError, sessionId, model, toolCalls, usage). Diagnostics go to stderr so stdout stays parseable; exit code 1 on error. `--prompt-file <path>` reads the prompt from a file.
- **Fixed: markdown tables sheared their borders**: marked-terminal sized columns to their content, so any table wider than the terminal wrapped and every box border broke. Tables are now fitted to the width — widest columns give way first, cells word-wrap, alignment markers honored — and re-wrap on resize like the rest of the transcript.
- **One visual system for the TUI** (design record in `docs/specs/tui-polish.md`): tool calls render as one block, `● Name(args)` then a `⎿` result line (per-tool stat — Bash shows its first lines, Read/Glob/Search show counts — duration when ≥1s, `ctrl+o` once per turn), rewritten in place when the result lands; the spinner names the running tool. `●` marks blocks (the assistant dot is now fg; green means tool-ok only), `⎿` is the only "under the block" glyph, `✓`/`✗` outcomes, `○ ● ✓` todos, `›` user lines, `❯` only for the prompt and list cursor; `└ » ✻ ✦ ↻ ✎ [x] >>` are gone. Every block gets one blank line. Meta lines are bare lowercase dim text with ` · ` separators. A dim receipt ends each turn (`⎿ done · 42s · 12.8k↑ 1.1k↓ · $0.01`). The footer truncates to one row and always ends with the one relevant hint.
- **Fixed: light-terminal input was black-on-black**: the cursor and the selected slash-command suggestion hardcoded `#000000`; the cursor is now an inverse cell placed before an all-dim placeholder (it no longer paints over the first letter), and no component hardcodes a color or stacks `dimColor` on gray.
- **Permission dialog**: patch-header noise (`Index:`, `===`, `---`, `+++`) is stripped, truncated previews say `… +N lines`, options are numbered and `1`/`2`/`3` pick directly, and **Esc cancels the dialog instead of aborting the whole turn** (same for the question dialog).
- **Replayed sessions look like live ones**: `--continue`/`--resume` render tool calls as `Name(args)` via the tool's own `summarize`, not the bare registry id.
- **Design specs**: `docs/specs/` holds one spec per feature — 20 written retroactively plus the TUI spec — with invariants mapped to tests, acceptance criteria, known gaps, and a cross-cutting gaps list; new work starts with a spec there.
- Under the hood, to stay under the 10,000-line `src/` budget: `/connect` and the `/help` list are shared by both frontends in `session-commands.ts`; `cli.ts` exports `RunFlags` and `teardown()` instead of three copies; the REPL reuses the print formatter's diagnostic lines; dead gradient code removed. `src/` is 9,923 lines.

- **Fixed: diff additions weren't green**: the permission-preview diff widget (the one actually shown when the agent proposes an edit) colored `+` lines with the `ok` role, which happened to equal plain body-text white — so deletions were red but additions were invisible as a color. `format.ts` and the markdown syntax theme already used the one accent green here; the diff widget was the one spot missed in that pass. Verified live: `+`/`-` lines now decode to accentBright green / error red, like Claude Code.
- **Fixed: plan mode and accept mode read as the same color**: `ok` (accept mode) was set to the same hex as `fg` (plain body text), so the accept-mode input border and status text didn't visually register as "colored" at all next to plan mode's genuinely gray magenta. `ok` now sits as its own distinct grayscale step between magenta and accent — idle/plan/accept/working are four visually distinct border colors again. Verified live via shift+tab cycling: dim → magenta → ok, each decodes to a different hex.

## 0.0.119 — 2026-09-03
- **Terminal tab title simplified**: was `✦ aerin — <dirname>` at rest and `✶ <your prompt, truncated> — aerin` while a turn ran; now always just `aerin`.
- **Fixed: assistant replies went ragged on terminal resize**: markdown was hard-wrapped to the terminal width once, at push time, and baked into the cached transcript text — resizing afterward left old replies double-wrapped and jagged (Ink re-wrapping already-hard-wrapped lines). Assistant items now keep their raw markdown alongside the rendered text, and a resize re-renders every cached reply at the new width. Verified live: shrinking and re-widening a real reply now reflows cleanly both ways.
- **Fixed: links inside bullet lists weren't clickable**: marked-terminal renders links fine in paragraphs but left `[text](url)` and bare autolinked URLs completely unstyled (no color, no OSC 8) inside list items — a real, common case for citation-style responses. Both link forms are now clickable inside lists too, matching how they already render in paragraphs.
- **Terminal bell on completion and on anything waiting for you**: a turn that ran long enough to log "done in Xs" now also rings the terminal bell (useful if you've alt-tabbed away); permission prompts and `ask_user` questions ring it immediately since the agent is blocked on you specifically.
- **No more yellow**: removed the last non-grayscale, non-accent color — amber (`warn`) was still showing up as a yellow input border while the agent works, a yellow permission-dialog border, a yellow context-usage warning, and a yellow "scrolled back" hint. The working-state input border now uses the one accent green (a meaningful, deliberate third use of it, alongside the wordmark/voice-marks and code keywords); the permission dialog and other status hints are plain white/gray. The `warn` role itself is removed from the theme — it had zero remaining users. Red stays for actual errors.
- Regression test locking in that a mid-session `/model` switch keeps the full prior conversation — `Agent.setModel()` never touched `this.messages`, but nothing verified it end-to-end until now.

## 0.0.118 — 2026-09-03
- **Jade theme, one green**: consolidated down to exactly one green (accentBright, Dark Jade) used only where it's meaningful — the wordmark, the "●"/"✻" marks that identify aerin's own voice, diff additions, and code keywords. Everything that used to be a second or third shade of green (links, headings, inline code, strings, numbers, function/class names, the input cursor, the loading spinner, plan-mode/section-header text) is now pure grayscale. Red and amber are unchanged (still functional error/warning signals).
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
