# Spec: Skills, custom commands and @mentions

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/skills-and-commands.md · Source: src/core/skills.ts (`discoverSkills`, `loadSkillBody`), src/tools/skill-tool.ts (`createSkillTool`), src/core/commands.ts (`discoverCommands`, `renderCommand`), src/core/mentions.ts (`expandMentions`), src/core/session-commands.ts (`skillsCommand`, `helpLines`), src/core/system-prompt.ts (skills section), src/cli.ts (registration), src/tui/App.tsx + src/modes/repl.ts (dispatch) · Tests: test/mentions-skills.test.ts, test/highvalue.test.ts (custom commands, `skillsCommand`)

## Goal

Give users three cheap, file-based ways to extend the agent without code, in the layout Claude
Code already uses so existing `.claude/` directories work unchanged: **skills** (instruction packs
the model loads on demand — list in the prompt, body only when needed), **custom commands** (prompt
templates run as `/name args`), and **@mentions** (attach a file or image to a prompt by path).
"Done" means: all three discover from project `.aerin/`, project `.claude/` and the global config
dir with that precedence; skills cost one line each in the system prompt until loaded; commands
substitute `$ARGUMENTS`; mentions attach text inline and images as multimodal parts.

## Non-goals

- Named sub-agents (`.aerin/agents/<name>.md`) are a separate feature (docs/subagents.md).
- No skill/command marketplace, versioning or remote fetch; files on disk are the whole model.
- No full YAML parser: frontmatter supports only `name` and `description` on single lines.
- No fuzzy or glob @mention resolution; a token must resolve to an existing file.
- Commands are not slash-command *implementations* — built-ins in `session-commands.ts` take
  precedence and a custom command can only produce a prompt.

## Constraints

- No new dependencies (hence the regex frontmatter parser).
- Windows: frontmatter and body stripping accept `\r?\n`; the mention regex accepts `\\` in paths.
- Line budget: skills 76, commands 63, skill tool 30, mentions 67 lines.
- Layering: discovery lives in core; the TUI and REPL only call `renderCommand` and
  `expandMentions`.

## Design

### Skills

`interface Skill { name; description; file /* abs SKILL.md */; dir }`.

`discoverSkills(cwd)` scans, in order, `<cwd>/.aerin/skills`, `<cwd>/.claude/skills`,
`<GLOBAL_CONFIG_DIR>/skills`. Each directory entry `<root>/<entry>/SKILL.md` is read; unreadable
entries are skipped. `parseFrontmatter` matches `^---\r?\n([\s\S]*?)\r?\n---` and extracts
`name:`/`description:` lines (surrounding quotes stripped). `name = fm.name ?? entry`;
`description = fm.description ?? "(no description)"`. A name already seen from an earlier root wins
(`Map` first-write). Result sorted by `localeCompare` on name.

`loadSkillBody(skill)` reads the file and strips `^---…---\r?\n?`, trimmed.

Prompt side (`buildSystemPrompt`): when `skills.length > 0`, a section
`Available skills (load with the skill tool BEFORE starting a task one covers):` followed by
`- <name>: <description>` lines. `cli.ts` registers `createSkillTool(skills)` only when at least one
skill exists.

`skill` tool: read-tier, `inputSchema { name: string }`, `summarize → Skill(<name>)`. Unknown name →
`throw Error("Unknown skill: <name>. Available: <list|none>")`. Otherwise returns
`truncateOutput("[Skill: <name> — follow these instructions. Files referenced by relative path live in <dir>]\n\n<body>")`.

`/skills` → `skillsCommand`: `No skills found. Add one at .aerin/skills/<name>/SKILL.md (existing .claude/skills are read too).`
or a padded `Skills:` table plus `The agent loads one with the skill tool when a task matches.`
`/status` lists skill names.

### Custom commands

`interface CustomCommand { name /* no slash */; description; template }`.

`discoverCommands(cwd)` scans `<cwd>/.aerin/commands`, `<cwd>/.claude/commands`,
`<GLOBAL_CONFIG_DIR>/commands` for `*.md`; `name = filename minus .md`; earlier roots win; template is
the trimmed file content, empty files skipped; `description` = first non-empty line with leading `#`s
removed, sliced to 70 chars. Sorted by name.

`renderCommand(command, args)`:
- template contains `$ARGUMENTS` → every occurrence replaced by the raw args string (`""` if none);
- else, args non-empty → `template + "\n\n" + args`;
- else → template.

Dispatch: the TUI (`App.tsx` slash-command `default:` branch) looks up `/${c.name} === cmd` only
after every built-in case and submits `runTurn(renderCommand(custom, arg), "<cmd> <arg>")` — the
transcript shows the typed command, the model gets the rendered prompt. The REPL takes the first
word after `/` and calls `runTurn(renderCommand(custom, rest))`. Both `runTurn`s pass the prompt
through `expandMentions`, so `@file` tokens inside a template expand. `/help` lists custom commands
as `/<name>  (custom) <description>` via `helpLines`; the TUI's suggestion list includes them.

### @mentions — `expandMentions(prompt, cwd): { text, images }`

Tokens: `/(?:^|\s)@([\w~][\w./\\-]*)/g` (an `@` at start or after whitespace; `a@b.com` does not
match). For each distinct `path.resolve(cwd, token)`:
- not a regular file (or any error) → token left untouched in the prompt;
- extension in `.png .jpg .jpeg .gif .webp` → image attachment `{ data: base64, mediaType, name }`,
  skipped silently past `MAX_IMAGES = 2` or above `MAX_IMAGE_BYTES = 2_000_000`;
- otherwise text, skipped past `MAX_FILES = 5`; content over `MAX_CHARS_PER_FILE = 20_000` is cut
  with `\n[...truncated]`; appended as `[Attached file: <token>]\n<content>`.

`text` = prompt + `\n\n` + attachments joined by `\n\n` (prompt unchanged when nothing attached).
Both frontends call it with `.catch(() => ({ text: prompt, images: [] }))` and pass `images` to
`Agent.send(text, images)`, which builds a multimodal user message. The TUI shows
`attached · <names>` for images.

## Invariants

- Precedence is `.aerin` > `.claude` > global for both skills and commands —
  `test/mentions-skills.test.ts` ("`.aerin` wins on name clash") and `test/highvalue.test.ts`
  ("discovers .aerin and .claude commands") cover the project roots; the global root is untested.
- A skill without frontmatter is named after its directory — `test/mentions-skills.test.ts`.
- `loadSkillBody` strips frontmatter and trims — `test/mentions-skills.test.ts`.
- `$ARGUMENTS` is replaced; templates without it get args appended after a blank line; no args → the
  template verbatim — `test/highvalue.test.ts`.
- Command description is the first non-empty line minus `#` — `test/highvalue.test.ts`.
- Mentions of non-files are left as text; text files are attached with the `[Attached file: …]`
  header; emails are not mentions — `test/mentions-skills.test.ts`.
- Image mentions become base64 attachments and are not inlined as text —
  `test/mentions-skills.test.ts`.
- The skill tool is read-tier and registered only when skills exist — untested.
- Skill list text appears in the system prompt — untested.
- Attachment caps (5 files / 20k chars / 2 images / 2 MB) — untested.

## Acceptance criteria

1. `discoverSkills` finds `.aerin` and `.claude` skills, prefers `.aerin` on a name clash, and reads
   frontmatter `name`/`description` — test/mentions-skills.test.ts.
2. Directory name is the fallback skill name — test/mentions-skills.test.ts.
3. `loadSkillBody` returns the body without frontmatter — test/mentions-skills.test.ts.
4. The global config dir is a third skills/commands root with lowest precedence — **gap**.
5. The `skill` tool returns the body with the `[Skill: … live in <dir>]` header and errors with the
   available list on an unknown name — **gap**.
6. The system prompt lists skills only when at least one exists, and the skill tool is registered
   only then — **gap**.
7. `/skills` prints the hint when none and the table otherwise — test/highvalue.test.ts (empty case
   only).
8. `discoverCommands` finds `.aerin`/`.claude` `*.md`, prefers `.aerin`, derives the description from
   the first line — test/highvalue.test.ts.
9. `renderCommand` substitutes `$ARGUMENTS`, appends args otherwise, returns the template verbatim
   with no args — test/highvalue.test.ts.
10. `/name args` in the TUI and REPL submits the rendered template as the turn's prompt, after
    built-ins — **gap** (no frontend test).
11. `expandMentions` attaches text files, leaves non-files, ignores emails — test/mentions-skills.test.ts.
12. Image mentions produce base64 multimodal parts — test/mentions-skills.test.ts.
13. Caps: at most 5 text files, 20k chars each with a truncation marker, 2 images, 2 MB each — **gap**.
14. `Agent.send` turns `images` into a `user` message with `text` + `image` parts — **gap**.

## Open questions / known gaps

- The mention regex admits `~` as a first character but `path.resolve` does not expand it, so
  `@~/notes.md` never resolves and is left as text.
- Frontmatter parsing is line-based: multi-line or block-scalar descriptions are dropped to
  `(no description)`; only `name` and `description` keys are read (Claude Code skills may carry
  more, e.g. `allowed-tools`, which are ignored).
- `parseFrontmatter` strips one pair of quotes only; a value like `"a" b` keeps its inner quotes.
- Command names come from filenames, so a custom command can shadow nothing (built-ins win) but two
  differently-cased files on a case-insensitive filesystem behave unpredictably.
- Skill bodies pass through `truncateOutput` (30k chars / 2000 lines) — a very long skill spills to
  a file and the model sees a pointer, which defeats the purpose; no size guidance is given to
  authors.
- Attachments are appended to the prompt text, so a mentioned file's content is stored verbatim in
  the session JSONL and counted against context on every later turn until pruned.
- No test covers the `skill` tool, the global roots, or frontend dispatch.

## Decisions

- 2026-07-22 (6ee9c72, v0.0.25): skills adopt Claude Code's `<dir>/SKILL.md` + frontmatter layout
  and read `.claude/skills` too, so users with existing skills need no migration.
- 2026-07-22 (6ee9c72): progressive disclosure — only `name: description` lines go into the system
  prompt; the body is fetched by a read-tier tool when a task matches (docs: "cheap list, body on
  demand").
- 2026-07-22 (6ee9c72): `.aerin` beats `.claude` beats global, implemented as first-write-wins in a
  `Map` over an ordered scan — simplest possible precedence.
- 2026-07-22 (6ee9c72): @mentions implemented in core (`mentions.ts`) and called by both frontends
  so TUI and REPL cannot drift; unresolvable tokens are left alone rather than erroring, because
  `@handle`-style text is common in prompts.
- 2026-07-22 (af5b112, v0.0.26): custom commands as markdown templates with `$ARGUMENTS`, Claude
  Code-compatible; templates without the placeholder get the args appended so a bare template still
  works as `/name extra context`.
- 2026-07-22 (64e9462, v0.0.57): image mentions become base64 multimodal parts ("string form
  survives JSONL session storage intact" — source comment) with a 2-image / 2 MB cap.
- 2026-07-22 (5c4aa1f → 6ee9c72): a hand-rolled regex frontmatter parser over a YAML dependency,
  under the lean-install rule.
