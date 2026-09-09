# Built-in tools

Source: `src/tools/`. All output passes the shared truncation + [spill](spill-files.md) layer; write/execute tools pass the [permission gate](permissions.md).

| Tool | Tier | What it does |
|---|---|---|
| `read` | read | Numbered lines, offset/limit, binary guard; refuses credential-shaped paths (`.ssh`, `.aws`, `id_rsa`…) |
| `write` | write | Create/overwrite a file; diff preview in the permission prompt |
| `edit` | write | Exact-string replacement, CRLF-normalized matching, `+A -R` diff stats |
| `ls` | read | Directory listing |
| `glob` | read | fast-glob file matching, gitignore-aware |
| `grep` | read | Content search, ripgrep-accelerated when available |
| `bash` | execute | Git Bash → PowerShell fallback on Windows; timeouts, tree-kill; `background:true` for jobs |
| `bash_output` | read | Poll a background job's output |
| `websearch` | read | Keyless DuckDuckGo search, SSRF-guarded |
| `webfetch` | read | Page → readable text, SSRF-guarded, untrusted-content wrapped |
| `agent` | read* | Sub-agents — research or `mode:"worker"` (see [sub-agents](subagents.md)) |
| `todo` | read | Live task checklist shown in the UI |
| `memory` | write | Save durable facts to AGENTS.md (see [memory](memory.md)) |
| `schedule` | read/execute† | Recurring commands via `every` — list/log/doctor are read, add/run/pause/resume/remove execute (see [scheduling](scheduling.md)) |
| `question` | read | ONE clarifying question with 2–4 options (only registered when a user can answer) |
| `skill` | read | Load a skill body on demand |
| `session_search` | read | Search/read past sessions (see [session search](session-search.md)) |
| `tool_search` / `tool_describe` / `tool_call` | read/execute | Bridges when MCP tools are deferred |
| `mcp__<server>__<tool>` | execute | Connected MCP server tools |

\* worker-mode actions are governed by the individual write/execute tools' permissions, not the agent tool's tier.
† `ToolDef.tierFor(input)` picks the tier per call; the static `permission` is the fallback.

Tool schemas stay flat with primitive types only — provider JSON-Schema quirks (Google/OpenAI/Ollama) break on unions and `format`.
