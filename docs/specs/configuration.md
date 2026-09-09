# Spec: Configuration

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/configuration.md · Source: src/config/config.ts (`configSchema`, `loadConfig`, `persistModelChoice`, `persistProviderKey`, `persistProjectRule`, `DEFAULT_MODEL`), src/config/paths.ts, src/cli.ts (flags, `setupAgent` model resolution), src/providers/registry.ts (`resolveApiKey`, `resolveModel`), src/core/session-commands.ts (`connectCommand`) · Tests: test/config.test.ts, test/highvalue.test.ts (custom providers)

## Goal

One documented set of keys, read from two JSON files with a fixed precedence, plus a handful of CLI
flags and env vars — so a user can answer "where does aerin get X from" without reading code, and so
interactive choices (`/model`, `/connect`, "always allow for this project") land in the right file.
"Done" means: unknown or malformed config fails loudly with the file name, project settings override
global ones per key, keys never need to live in the project file, and the persist helpers
round-trip without clobbering unrelated keys.

## Non-goals

- No environment-variable form for arbitrary keys; only provider API keys read env.
- No config for the TUI (theme, keybindings) or per-tool options.
- No schema migration or versioning; files are plain JSON parsed on every start.
- CLI flags are not persisted (except that `/model` persists a model choice; `-m` does not).

## Constraints

- One dependency for locations (`env-paths`); no new deps.
- Windows: `env-paths` gives `%APPDATA%`/`%LOCALAPPDATA%`-based dirs; all paths built with
  `node:path`.
- Layering: `src/config/` imports nothing from tools, core or UI.
- Line budget: `config.ts` 160 lines, `paths.ts` 30 lines.

## Design

### Locations — `paths.ts`

```
paths = envPaths("aerin", { suffix: "" })
GLOBAL_CONFIG_DIR   = paths.config                       // ~/.config/aerin on Linux; Library/Preferences/aerin on macOS; %APPDATA%\aerin on Windows
GLOBAL_CONFIG_FILE  = <GLOBAL_CONFIG_DIR>/config.json
DATA_DIR            = paths.data                         // sessions/<hash>, shadow/<hash>, spill/, loops/
projectConfigDir(cwd)   = <cwd>/.aerin
projectSettingsFile(cwd)= <cwd>/.aerin/settings.json
sessionsDir(cwd) / shadowGitDir(cwd) = <DATA_DIR>/{sessions,shadow}/<sha256(resolve(cwd)).slice(0,12)>
```

Skills, commands and agents also read `<GLOBAL_CONFIG_DIR>/{skills,commands,agents}`.

### Schema — `configSchema` (zod)

| Key | Type | Notes |
|---|---|---|
| `model` | string? | `provider/model-id` |
| `subagentModel` | string? | sub-agents and the goal judge |
| `recentModels` | string[]? | maintained by `persistModelChoice`; global only |
| `hooks` | record<string,string>? | `pre:<tool>` / `post:<tool>` / `*` / lifecycle keys |
| `diagnostics` | string \| false? | post-edit check; `false` disables; unset auto-detects |
| `deferMcpTools` | boolean? | force deferral |
| `fallbackModels` | string[]? | failover chain |
| `providers` | record<name, { apiKey?, baseURL?, headers?: record, protocol?: "openai"\|"anthropic" }>? | any name with `baseURL` is routable |
| `mcpServers` | record<name, { command, args?, env? } \| { url (URL), headers? }>? | |
| `permissions` | { allow: string[] = [], deny: string[] = [] }? | rule syntax in docs/permissions.md |

`configSchema` is a non-strict `z.object`, so unknown top-level keys are dropped silently.
`DEFAULT_MODEL = "anthropic/claude-opus-4-8"`.

### Loading — `loadConfig(cwd): { config, globalConfig, projectConfig }`

`readJsonIfExists`: `ENOENT` → `undefined`; any other read/parse failure → `Error("Failed to parse
<file>: <message>")`. Each raw object goes through `configSchema.parse` (zod errors propagate
unwrapped). Merge, global ← project:

| Key | Rule |
|---|---|
| `model`, `subagentModel` | `project ?? global` |
| `recentModels` | global only (a project value is ignored) |
| `hooks` | `{ ...global, ...project }` — per hook key |
| `diagnostics`, `deferMcpTools`, `fallbackModels` | `project ?? global`, key omitted when both undefined (arrays replace whole) |
| `providers`, `mcpServers` | `{ ...global, ...project }` — per provider/server name, entry replaced whole (no deep merge of `apiKey` + `baseURL` across files) |
| `permissions.allow`, `.deny` | `[...global, ...project]` concatenated |

Runtime precedence on top (in `setupAgent`): `modelId = flags.model ?? config.model ?? DEFAULT_MODEL`;
API key = `process.env[PROVIDERS[p].envVar] ?? config.providers[p].apiKey` (env wins:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`,
`XAI_API_KEY`; Ollama needs none; custom providers use config only). `--yolo` and
`config.permissions` combine in `new PermissionPolicy(allow, yolo, deny)`.

Model resolution failure: `-m` fails loud; otherwise a detected local Ollama model is used with a
warning, else (keys exist) an inert stub that errors on use, else the zero-key welcome message —
aerin never auto-selects a paid model.

### CLI flags (`main()`, commander)

`-m/--model <id>`, `-p/--print`, `--output-format text|json` (validated against `OUTPUT_FORMATS`,
error to stderr + exit 1), `--prompt-file <path>` (appended after argv prompt), `--no-tui`, `--yolo`,
`-c/--continue`, `-r/--resume <id>`, `--allow-outside-cwd`, `--cwd <dir>`, `--no-mcp`. Subcommands
`aerin doctor` / `aerin update` are routed before parsing. `RunFlags` (`model yolo continue resume
allowOutsideCwd cwd mcp`) is the subset every frontend receives. Env: `AERIN_EVERY_BIN` (schedule
tool binary override).

### Persist helpers (read-modify-write of the raw JSON, 2-space indent + trailing newline, `mkdir -p`)

- `persistModelChoice(modelId, file = GLOBAL_CONFIG_FILE)`: sets `model`, then
  `recentModels = [modelId, ...recent.filter(≠ modelId)].slice(0, 5)`. Called (best-effort,
  `.catch(() => {})`) by the TUI and REPL `/model`.
- `persistProviderKey(provider, apiKey, baseURL?, protocol?, file = GLOBAL_CONFIG_FILE)`: merges
  non-empty fields into `providers[provider]`, preserving others. Called by `connectCommand`
  (`/connect`), which then updates the in-memory `config.providers` and validates the key by listing
  models. `headers` is config-file-only.
- `persistProjectRule(cwd, rule)`: appends to `.aerin/settings.json` `permissions.allow`, deduped.
  Called by `Agent.dispatchToolCall` on `allow-always` with `scope: "project"`.

All three operate on the raw object, so keys the schema does not know survive a rewrite.

## Invariants

- Missing files yield defaults (`permissions.allow = []`) — `test/config.test.ts` ("loads defaults").
- Project `model` overrides global and project allow rules merge in — `test/config.test.ts`
  ("project settings override and merge"); global+project concatenation order is untested.
- `subagentModel` parses; project overrides global — `test/config.test.ts`.
- `persistProjectRule` never duplicates a rule — `test/config.test.ts`.
- Custom provider `headers`/`protocol` parse from project settings — `test/config.test.ts`.
- Malformed JSON raises `Failed to parse <file>` — `test/config.test.ts`.
- `persistModelChoice` sets `model`, dedupes and caps `recentModels` at 5, newest first —
  `test/config.test.ts`.
- `providersWithKeys` reflects configured keys exactly (with env cleared) — `test/config.test.ts`.
- A `baseURL` provider entry resolves through the OpenAI-compatible adapter —
  `test/highvalue.test.ts` ("custom providers").
- Env var beats config `apiKey` — untested.
- `persistProviderKey` merges without dropping sibling fields — untested.
- `hooks`, `providers`, `mcpServers` per-key merge; `deny` concatenation; `fallbackModels` /
  `deferMcpTools` / `diagnostics` precedence — untested.
- Unknown keys are preserved by the persist helpers — untested.

## Acceptance criteria

1. No config files → schema defaults, no error — test/config.test.ts.
2. `.aerin/settings.json` `model` overrides global; its `permissions.allow` is present in the merged
   list — test/config.test.ts.
3. `subagentModel` from the project file is used — test/config.test.ts.
4. Invalid JSON in either file fails with `Failed to parse <path>` — test/config.test.ts (project file
   only; global is a **gap**).
5. `providers.<custom>` with `baseURL`/`protocol`/`headers` parses and merges — test/config.test.ts.
6. `persistProjectRule` appends once per rule and the rule is visible on reload — test/config.test.ts.
7. `persistModelChoice` maintains `model` and a 5-entry deduped `recentModels` — test/config.test.ts.
8. `providersWithKeys` lists exactly the providers with a key — test/config.test.ts.
9. Env API key takes precedence over `providers.<p>.apiKey` — **gap**.
10. `persistProviderKey` writes `apiKey`/`baseURL`/`protocol` and preserves existing fields and
    unrelated top-level keys — **gap**.
11. `permissions.deny` merges global then project — **gap**.
12. `hooks`/`providers`/`mcpServers` merge per key with project winning — **gap**.
13. `fallbackModels`, `deferMcpTools`, `diagnostics` (incl. `false`) take the project value over the
    global one — **gap**.
14. `recentModels` in the project file is ignored — **gap**.
15. `--output-format` rejects values outside `text|json` with exit code 1 — **gap**.
16. `-m` with an unresolvable model fails loudly; a configured unresolvable model falls back to Ollama
    or an inert stub without spending — **gap**.
17. `--prompt-file` content is appended to the argv prompt — **gap**.
18. Zod validation errors (e.g. `mcpServers.x.url` not a URL) surface at startup — **gap**.

## Open questions / known gaps

- Zod errors are thrown raw (a multi-line zod message without the file name), unlike JSON parse
  errors which are wrapped; the user has to guess which file is wrong.
- Unknown keys are silently dropped on load — a typo like `fallbackModel` does nothing and says
  nothing. `aerin doctor` does not detect it.
- `providers`/`mcpServers` entries replace whole across files, so a global `apiKey` and a project
  `baseURL` for the same provider name cannot be combined.
- The schema permits `apiKey` in the project file; the docs warn against it but nothing stops a
  commit. `/connect` always writes to the global file, which is the intended path.
- `persistModelChoice` writes the global file even when the model came from a project setting, so
  the next session in another project starts on this model.
- There is no `aerin config` command; editing is by hand or via `/model`, `/connect`, "always allow".
- `test/config.test.ts` also hosts `truncateOutput` tests, which belong to the tools contract.

## Decisions

- 2026-07-22 (5c4aa1f, initial): two files — global `config.json` and project `.aerin/settings.json`
  — merged global ← project, with `permissions` concatenated rather than overridden so a project can
  only add rules.
- 2026-07-22 (5c4aa1f): zod schema over hand validation, with a non-strict object so older/newer
  files keep loading.
- 2026-07-22 (5c4aa1f): `env-paths` for platform-correct directories instead of hardcoding
  `~/.config`; a hashed per-project data dir keeps sessions and shadow-git out of the repo.
- 2026-07-22 (139e254, v0.0.8): never auto-select a paid model when the configured one is
  unavailable — Ollama or an inert stub instead.
- 2026-07-22 (5bb23be, v0.0.24): `/model` persists `model` + `recentModels` to the global file only;
  `-m` and project settings still win for one-off runs.
- 2026-07-22 (af5b112, v0.0.26): custom providers are any `providers.<name>` with a `baseURL`; keys
  can live in config or env, env first, so CI and shared machines need no file edits.
- 2026-07-23 (7be1dc7, v0.0.92): `permissions.deny` added alongside `allow` with the same merge.
- 2026-07-23 (d0832cd / e7fc7af / f038545): `fallbackModels`, `deferMcpTools`, `diagnostics` use
  `project ?? global` whole-value precedence — no partial merges for scalars and chains.
- 2026-09-03 (0222e19): `providers.<name>.protocol` and `.headers` for Anthropic-Messages-shaped or
  oddly-authenticated endpoints; `headers` deliberately config-file-only ("not worth a multi-key-value
  prompt" in `/connect`).
