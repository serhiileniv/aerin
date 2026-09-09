# Spec: TUI polish — one visual system

Status: **approved 2026-09-09, implemented** (all four open questions resolved as recommended). Date: 2026-09-09.
Inputs: a read-only audit of `src/tui/` + `src/terminal/` and a source-level survey of Claude Code, Codex CLI, Gemini CLI, opencode, Crush, goose, Aider, Amp (sources at the end).

## Goal

Make aerin's TUI read as one deliberate system: one glyph per meaning, one accent color per role, one blank-line rhythm, one grammar for meta lines, nothing that overflows the terminal width, and nothing that reads differently on a light terminal. Match the conventions the leading agents share, so a Claude Code / Codex user feels at home.

## Non-goals

- No new features (no fullscreen/scrollback rewrite, no theme files, no mouse changes, no new dialogs).
- No renderer change (stays on Ink); no new dependencies.
- No change to the `AgentEvent` contract or to core/tools.
- Not a fix for the live-vs-scrolled row-count drift (`scroll.ts`); tracked separately.

## Constraints

- `src/` must stay under 10,000 lines (CI). Today: 9,981. Every item below states its net line cost; the plan deletes dead code first (−45) so the whole spec is net-negative.
- Windows first-class: glyphs must be single-width and non-emoji (Unicode `Emoji_Presentation=No`, no U+FE0F, no Nerd Font PUA).
- Both frontends must not drift: anything shared goes in `core/session-commands.ts`; TUI-only rendering in `src/tui/`.

## Current state (what is off)

| Area | Today | Problem |
|---|---|---|
| Block markers | Assistant `●` green; tool ok `●` same green; running `●` dim; error `●` red | Assistant and tool-ok are indistinguishable. |
| "Child" glyphs | `⎿` (tool result), `└` (attached, done-in, sub-agent done), `»` (sub-agent running), `✻` (reasoning), `✦` (banner) | Five glyphs for "belongs to the block above". |
| `❯` | User prefix, input prompt, list selection, queued commands | One glyph, four meanings. |
| Spacing | Blank line after user/assistant only; tool blocks butt against the next block | Uneven rhythm; the rule is duplicated in `App.tsx` and `scroll.ts`. |
| Meta lines | `(update available …)`, `[compacting …]`, `── resumed … ──`, `Model switched to X`, `✓ goal complete —`, `↻ goal continues (…) —` | Four wrapper styles and four separators (` · `, ` — `, `, `, `  `). |
| Tool result | `⎿ stat · 1.3s · ctrl+o`; meta appended after clipping | Line can exceed width; `ctrl+o` repeated on every collapsed result; diff preview lands *above* the rail; replay shows `● bash` vs live `● Bash(ls)`; MCP/agent summaries don't match `Name(args)`. |
| Status bar | One `<Text>` with default wrap, `>>` ASCII badge, `(shift+tab)` twice | Wraps to 2–3 rows on narrow terminals and steals transcript height. |
| Input | Cursor drawn over the first placeholder char; `color="#000000"` hardcoded (×2); `dimColor` stacked on gray (×3); 66-char working placeholder | Light theme: cursor and selected suggestion are black-on-near-black; placeholder reads as typed text; box wraps under ~72 cols. |
| Permission dialog | Raw `createTwoFilesPatch` header (`Index:`, `===`, `---`, `+++`) shown; silent truncation at 25 lines; Esc aborts the whole turn | Noise, hidden risk, destructive Esc. |
| Todo panel | `[x] [>] [ ]` | ASCII in a glyph UI. |
| Dead code | `src/terminal/gradient.ts` + `C.heroGradient` | 45 unreferenced lines under a hard budget. |

## Design

### 1. Glyph system (exactly this set)

| Meaning | Glyph | Notes |
|---|---|---|
| Block marker (assistant, tool) | `●` U+25CF | Color carries the role (below). |
| Child of the block above | `⎿` U+23BF | Tool results, diffs, attached files, "done in", sub-agent lines. `└`, `»` removed. |
| Success / failure | `✓` U+2713 / `✗` U+2717 | Goal complete, key works, tool error, connect errors. `↻`, `✎` removed. |
| Todo pending / active / done | `○` U+25CB / `●` / `✓` | Replaces `[ ] [>] [x]` in TUI and REPL. |
| Input prompt and list cursor | `❯` U+276F | Only these two. |
| User transcript line | `›` U+203A, dim, text bold | Distinct from the prompt (Codex convention). |
| Stream cursor | `▌` | unchanged |
| Spinner | braille `⠋…⠏` | unchanged |
| Ellipsis | `…` everywhere | `bash.ts` summarize switches from `...`. |
| Separator in meta lines | ` · ` | ` — ` only inside prose. Never `, ` in meta. |
| Reasoning tail | `⎿ thinking` prefix on first line, italic dim | `✻` removed. |
| Narrow banner | `● aerin` | `✦` removed. |

### 2. Color roles

| Token | Role (dark / light values unchanged) |
|---|---|
| `fg` | Body text, tool name, **assistant `●`** (was green), user text |
| `accentBright` (the one green) | *Status only*: tool-ok `●`, diff `+`, `✓`, code keywords, working input border |
| `error` | Errors, tool-error `●`/`⎿`, diff `-`, deny box |
| `dim` | All meta: `⎿` lines, info lines, idle borders, placeholder, footer |
| `accent` | Selection text, tool args, dialog borders, links, headings |
| `ok` / `magenta` | Accept / plan mode **badge text and border**; on light theme the badge text is the cue, not the shade |

Rules: no hardcoded hex in components (`#000000` ×2 → `<Text inverse>`); no `dimColor` on truecolor text; the light palette is exercised by a test that renders the input with `applyBackgroundTheme(true)` and asserts no `#000000`.

### 3. Transcript rhythm

- Every block (`user`, `assistant`, `tool`) is followed by one blank line; `info`/`error` lines are not. Rule lives in **one** place: `scroll.ts` exports `blockGap(kind)`, `App.tsx` uses it for `marginBottom`.
- Continuation indent is 2 for user/assistant text and 5 (`⎿  ` width) for everything under a rail; a wrapped `● Name(args)` line gets a 2-col hanging indent via `wrap="wrap"` + baked indent in `tool-line.ts`.
- The streaming block gets the same bottom margin as a committed assistant block (no one-row jump at `message-end`).

### 4. Tool blocks (`tool-line.ts`)

```
● Read(src/tui/App.tsx)
  ⎿  1,240 lines · 1.3s
● Bash(bun test)
  ⎿  bun test v1.3
     296 pass
     0 fail
     … +2 lines
● Update(src/x.ts)
  ⎿  Updated src/x.ts (+3 -1)
     - old line
     + new line
● Bash(git push)
  ⎿  ✗ fatal: not a git repository
```

- Width: clip *after* composing the meta suffix so no line exceeds `mdWidth()`.
- `ctrl+o` hint appears once per turn (first collapsed result), then only `…` — the footer already says `? for shortcuts`.
- Diff preview (`tool-display`) is rendered **under** the `⎿` result line, indented 5, `+`/`-` colored, `@@` dim; the result-rewrite logic already handles "something landed between call and result" — it now inserts the result line *before* the diff item.
- Summaries: every tool's `summarize` returns `Name(args)`; MCP tools become `Mcp(server.tool)`; agent-nested calls `Agent(desc) › Read(x)`; replay renders `Name(args)` from the stored input via `summarize`, not the registry id.
- Sub-agents: running `  ⎿  agent: desc · 3 tools · Read(x)` dim; finished `  ⎿  agent done · desc · 3 tools · 1.2k tok · $0.0012`.

### 5. Turn receipt

After each finished turn, one dim line under the last block (Codex/Claude Code convention):

```
  ⎿  done · 42s · 12.8k↑ 1.1k↓ · $0.0123
```

Replaces the current `  └ done in 42s`. Cost via one `fmtCost()` used by the receipt, `/status`, the footer and sub-agent lines (today three formats).

### 6. Footer (status bar)

One row, `wrap="truncate-end"`, ` · ` separators, priority order left→right so the *right* items drop first when narrow:

```
anthropic/claude-opus-4-8 · ctx 42% · 12.8k↑ 1.1k↓ · $0.0123 · plan · ↑ scrolled · esc to interrupt · ? for shortcuts
```

- Mode badge is plain text `plan` / `accept edits` (no `>>`, no repeated `(shift+tab)`); `shift+tab` is documented in `/help`.
- `Ctrl+C again to exit` and `esc to interrupt` are the only transient hints; they replace, not append.
- The input border still recolors by mode; the badge is the cue that survives light themes.

### 7. Input

- Placeholder rendered entirely dim; the cursor is `<Text inverse>` on a space *before* the placeholder, never over its first letter.
- Placeholder text ≤ 40 chars: idle `ask anything · @file · / commands`, working `queued for after this turn`.
- Suggestion rows and picker rows use the same selection style: `❯ ` + `accent` text, no background fill.
- Queued commands render as `  ⎿  queued: /compact` dim (no `❯`, no `dimColor`).

### 8. Dialogs

- Permission: strip the four patch header lines; when the preview is truncated append `… +N lines` dim; options numbered `1 Yes · 2 Yes, always for this project · 3 No, tell the agent what to do instead` with `1/2/3` as accelerators; **Esc = No** (does not abort the turn). Border `accent`, same as the question dialog.
- Question: unchanged except Esc = "type a different answer" instead of aborting the turn.
- Pickers: loading state uses `<Spinner label="fetching models" />`; row suffixes use ` · ` and `✓` only; session rows truncate the title to the available width.

### 9. Meta-line grammar

Bare, lowercase, dim, no wrappers; `✓`/`✗` only when it is an outcome:

| Today | Spec |
|---|---|
| `(update available: v… — run "aerin update")` | `update available · v0.0.120 · aerin update` |
| `[compacting context — was N tokens]` | `compacted context · was N tokens` |
| `── resumed conversation (N messages) ──` | `resumed · N messages` |
| `Model switched to X` | `model · X` |
| `warning: …` in red | `warning · …` dim (errors stay red with `✗`) |
| `✓ goal complete — r` / `↻ goal continues (N turns left) — r` | `✓ goal complete · r` / `goal continues · N turns left · r` |
| `(provider error — retrying, attempt 1/3: m)` | `retry 1/3 · m` |
| `(x failed: m — continuing on y)` | `failover · x → y · m` |

`/help` gains bold section labels and a hanging indent; the shortcut column is padded like the command column. `/status` version line becomes `aerin v0.0.119 · v0.0.120 available · aerin update`.

### 10. Startup

Banner unchanged in shape; `SUNSET` renamed `JADE`; the 42-column check re-runs on resize; light theme keeps the row fade by using the light `heroGradient` stops instead of a flat color. Warnings under the banner follow §9.

## Line budget plan

| Step | Net lines |
|---|---|
| Delete `terminal/gradient.ts`, `C.heroGradient`, `test/gradient.test.ts` (unless §10 reuses the gradient — decide in Q1) | −45 (src) |
| Glyph/grammar swaps (§1, §9, todo, sub-agent) | 0 |
| `blockGap()` single source (§3) | −2 |
| `fmtCost()` + receipt (§5) | +2 / −4 |
| Footer truncate + badge text (§6) | −1 |
| Input fixes, `<Text inverse>`, placeholder (§7) | −2 |
| Permission header strip + `… +N lines` + numbered keys + Esc=No (§8) | +8 |
| Tool-line width/`ctrl+o`-once/diff-under-rail/summaries (§4) | +4 |
| Light-theme regression test | test only |
| **Total** | **≈ −40 src lines** (→ ~9,940) |

## Acceptance criteria

1. `grep -rn '└\|»\|✻\|✦\|↻\|✎\|\[x\]\|>>' src/tui src/modes src/terminal` returns nothing.
2. Every transcript line ≤ terminal width at 60, 80, 120 cols (test renders `formatToolBlock`, footer, help, and a 200-char `Bash(...)` summary through `wrapAnsiLine` and asserts).
3. Light theme: no `#000000` or `dimColor` in `src/tui`; a test renders `LineInput` under `applyBackgroundTheme(true)` and finds no black-on-dark pair.
4. Esc in a permission dialog denies that call only; the turn continues (test through `onPermissionRef`).
5. A replayed session (`--continue`) shows identical tool lines to the live run (test: replay a stored tool-call part and compare with `formatToolCall`).
6. `bun test`, typecheck, build, `check:no-bun-globals` green on macOS, Linux, Windows; `src/` ≤ 9,960 lines.
7. Screenshots (dark + light, 80 cols) attached to the PR for: startup, a turn with Read + Bash + Update, a permission dialog, the footer at 60 cols.

## Open questions (need your call)

1. **Banner gradient on light theme**: keep the per-row fade (reuse the existing gradient code, ~0 net) or delete `gradient.ts` for the −45 lines and accept a flat green logo on light terminals? Recommendation: delete; the logo is 6 rows and the fade is invisible on light anyway.
2. **User prefix**: switch the transcript's user lines from `❯` to `›` (Codex) so `❯` means "input/selection" only, or keep `❯` and instead drop it from queued commands? Recommendation: `›`.
3. **Turn receipt** (§5): always, or only when the turn took ≥ 3 s / ran a tool? Recommendation: always; it is one dim line and it is where cost lives.
4. **`ctrl+o` hint once per turn** vs on every collapsed result? Recommendation: once.

## Sources

Audit: `src/tui/App.tsx`, `src/tui/components/widgets.tsx`, `src/tui/theme.ts`, `src/tui/tool-line.ts`, `src/tui/scroll.ts`, `src/terminal/markdown.ts`, `src/terminal/format.ts` (2026-09-09).
Conventions: Claude Code docs (statusline, interactive-mode, terminal-config, permission-modes, fullscreen) and CHANGELOG; Codex `codex-rs/tui` (`styles.md`, `exec_cell/render.rs`, `diff_render.rs`, `status_indicator_widget.rs`, `bottom_pane/*`); Gemini CLI `packages/cli/src/ui` (`Footer.tsx`, `ToolMessage.tsx`, `InputPrompt.tsx`, `ToolConfirmationMessage.tsx`); opencode `packages/tui/src` (`routes/session/*`, `component/prompt`); Crush `internal/ui` (`styles.go`, `chat/tools.go`, `dialog/permissions.go`); goose `goose-cli/src/session/output.rs`; clig.dev; no-color.org; Unicode `EastAsianWidth.txt` / `emoji-data.txt`.
