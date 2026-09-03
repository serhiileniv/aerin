<p align="center">
  <img src="https://raw.githubusercontent.com/Serhii-Leniv/aerin/main/docs/assets/aerin-wordmark.svg" alt="AERIN" width="440">
</p>

<p align="center"><b>The coding agent you can actually read.</b><br/>
Every feature the big agents have — sub-agents, undo that covers bash, autonomous goals, hooks, MCP —<br/>
in ~9k lines of TypeScript with a <a href="docs/index.md">docs page per feature</a> pointing at the source. $0 to start.</p>

<!-- Hero demo GIF: record demo/quickstart.tape with vhs (see demo/README.md), then uncomment:
<p align="center"><img src="https://raw.githubusercontent.com/Serhii-Leniv/aerin/main/demo/demo.gif" alt="aerin demo" width="820"></p>
-->

<p align="center">
<a href="https://github.com/Serhii-Leniv/aerin/actions/workflows/ci.yml"><img src="https://github.com/Serhii-Leniv/aerin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="https://www.npmjs.com/package/aerin-agent"><img src="https://img.shields.io/npm/v/aerin-agent" alt="npm"></a>
<a href=".github/workflows/ci.yml"><img src="https://img.shields.io/badge/src-%3C10k_lines,_CI--enforced-00c078" alt="line budget"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
<a href="#install">Install</a> ·
<a href="#quick-start">Quick start</a> ·
<a href="#read-the-code">Read the code</a> ·
<a href="#features">Features</a> ·
<a href="docs/index.md">Docs</a> ·
<a href="#configuration">Configuration</a>
</p>

---

## Read the code

Aerin's differentiator isn't a feature — it's that you can **understand the whole thing**. The [architecture tour](docs/architecture.md) walks the codebase in 8 stops (~20 minutes): the event-stream contract, the agent loop, the permission gate, shadow-git undo, the context economy, sub-agents, and how it all assembles. Every feature's [docs page](docs/index.md) names its source files and invariants. The `src/` tree stays **under 10,000 lines, CI-enforced** — smallness is a promise, not an accident. If you've ever wanted to know how coding agents actually work, this is the codebase to read — and [to contribute to](CONTRIBUTING.md).

$0 to start, too: keyless web search, local models via Ollama/LM Studio/vLLM, and aerin never auto-selects a paid model on your behalf.

## Install

```sh
npm install -g aerin-agent     # or: npx aerin-agent
```

The installed command is `aerin`. Requires Node 20+.

## Quick start

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY
cd your-project
aerin                                  # interactive TUI
aerin "fix the failing test"           # TUI with an opening prompt
aerin --no-tui                         # plain readline REPL
aerin -p --yolo "summarize this repo"  # headless, auto-approve, print, exit
```

Switch models any time with `-m provider/model-id` or `/model` inside the session:

```sh
aerin -m openai/gpt-4o
aerin -m google/gemini-flash-latest
aerin -m ollama/llama3.1               # local, no key needed
```

## Features

Every feature has a page in the [docs knowledge base](docs/index.md) with mechanics, invariants, and source pointers.

- **[Any model, any provider](docs/model-families.md)** — Anthropic, OpenAI, Google, OpenRouter, xAI, local Ollama, plus [any OpenAI- or Anthropic-Messages-compatible endpoint](docs/configuration.md#connecting-an-anthropic-messages-shaped-or-oddly-authenticated-endpoint) via a few-line config entry, custom headers included for gateways that don't use a plain Bearer key. The system prompt is tuned per model family and follows `/model` switches; aerin never auto-selects a paid model.
- **[Real coding tools](docs/tools.md)** — read/write/edit (CRLF-safe), glob, ripgrep-accelerated grep, a shell with a proper Windows strategy, background jobs, keyless web search/fetch.
- **[Sub-agents](docs/subagents.md)** — read-only researchers with their own context windows, write-capable workers under your permission rules, and named custom agents from markdown files.
- **[Autonomous goal loop](docs/goal-loop.md)** — `/goal <text>` keeps working until an evidence-based judge sees it done: fail-open, turn-budgeted, steered by not-done verdicts.
- **[Permissions](docs/permissions.md)** — read/write/execute tiers, allow rules as prefix globs, deny rules that beat everything (even `--yolo`), and a [doom-loop breaker](docs/doom-loop.md) that interrupts identical-call retry spirals.
- **[Undo & redo](docs/undo-redo.md)** — `/undo` reverts the last turn's file changes *including bash side effects* via a shadow git repo; `/redo` walks forward.
- **[Hooks](docs/hooks.md)** — shell hooks around tool calls with a JSON protocol (allow/deny/ask, input rewrite, context injection) plus lifecycle events: `session:start`, `prompt:submit`, `turn:end` (a stop-gate that can demand more work), `compact:pre`, `session:end`.
- **[Provider failover](docs/provider-failover.md)** — rate limits, outages, and spent quotas roll onto the next `fallbackModels` entry mid-turn instead of killing it.
- **[Post-edit diagnostics](docs/diagnostics.md)** — your typecheck runs after every edit and failures feed straight back; zero-config with a `typecheck` script.
- **[Bounded memory](docs/memory.md)** — durable facts in `AGENTS.md` under a hard 2,500-char budget; a full memory forces consolidation instead of growing forever.
- **[Sessions](docs/sessions.md) & [recall](docs/session-search.md)** — JSONL history with `--continue`/`/resume`, [compaction](docs/compaction.md) that *updates* a structured running summary, and a `session_search` tool over past conversations.
- **[Spill files](docs/spill-files.md)** — truncated tool output is saved in full for grepping/slicing instead of re-running commands.
- **[MCP](docs/mcp.md)** — paste your `mcpServers` config and the tools appear; [deferred loading](docs/deferred-mcp-tools.md) keeps big servers from flooding the context.
- **[Skills & custom commands](docs/skills-and-commands.md)** — instruction packs and `/name` prompt templates, Claude Code-compatible (`.claude/` layouts are read too).
- **Terminal UI** — full-screen Ink TUI with streamed markdown, in-app scrolling, multi-line input, `@file` fuzzy autocomplete, `/` command suggestions, live todo checklist, diff previews, and a context/cost meter — plus `--no-tui` (REPL) and `-p` (headless). Plan mode (`/plan`) makes everything read-only until you approve.

## Configuration

Global: `~/.config/aerin/config.json` (platform-appropriate). Per-project: `.aerin/settings.json`. Full reference: [docs/configuration.md](docs/configuration.md).

```json
{
  "model": "anthropic/claude-opus-4-8",
  "subagentModel": "anthropic/claude-haiku-4-5",
  "fallbackModels": ["openrouter/deepseek/deepseek-chat"],
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "deepseek": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-..." },
    "ollama": { "baseURL": "http://localhost:11434/v1" }
  },
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  },
  "permissions": {
    "allow": ["bash(git *)", "write(src/*)", "mcp__github__*"],
    "deny": ["bash(rm *)", "write(.env*)", "edit(.env*)"]
  }
}
```

Any provider name that isn't built in but has a `baseURL` is routable — OpenAI-compatible by default, or `"protocol": "anthropic"` for endpoints speaking the Anthropic Messages API instead — covering DeepSeek, Kimi, Groq, Cerebras, Together, Fireworks, LM Studio, vLLM, MiniMax, and friends. `/connect`'s picker adds a curated list (Chinese platforms included: Alibaba/Qwen, SiliconFlow, Volcengine, StepFun, SenseNova, Tencent Hunyuan, MiniMax, …) plus a live "all providers" section pulled from [models.dev](https://models.dev)'s 170+-entry registry — new providers and models need no aerin update, see [docs/configuration.md](docs/configuration.md#new-providers-and-models-require-no-code-changes).

Never put API keys in the *project* config — it gets committed. Use env vars, the global config, or `/connect` inside aerin.

## Permission rules

Reads are always allowed; writes and commands ask. Rules are simple prefix globs — `bash(git *)`, `write(src/*)`, `mcp__github__*` — persisted per project when you choose "always". A `deny` list beats everything, applies to read-tier too, and matches each segment of chained bash commands. Details: [docs/permissions.md](docs/permissions.md).

## Development

```sh
bun install
bun test            # unit tests
bun run typecheck
bun run dev         # run from source
bun run build       # dist/ via tsdown
```

The core (`src/core`, `src/tools`, …) never imports Ink/React — the TUI is one of three frontends over the same `AsyncIterable<AgentEvent>` stream, which keeps everything testable headless. Agent contributors: start at [AGENTS.md](AGENTS.md) and [docs/index.md](docs/index.md).

## License

MIT
