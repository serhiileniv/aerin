# Aerin knowledge base

**New here? Start with the [architecture tour](architecture.md)** — how a coding agent works, end to end, as a guided reading path through aerin's source.

One page per feature: what it does, how to use it, how it works, and where the code lives. **Agents: read the page for a subsystem before changing it** — each page names the source files and the invariants that must hold.

## Safety & permissions
- [Permissions](permissions.md) — read/write/execute tiers, manual/accept/plan modes, allow rules, deny rules that beat everything.
- [Doom-loop breaker](doom-loop.md) — the 4th identical tool call asks the user before more tokens burn.
- [Undo & redo](undo-redo.md) — shadow-git snapshots; `/undo` covers bash side effects, `/redo` walks forward.
- [Hooks](hooks.md) — shell hooks around tool calls; legacy exit codes or the JSON protocol (allow/deny/ask, input rewrite, context injection).

## Working autonomously
- [Goal loop](goal-loop.md) — `/goal <text>` keeps working until an evidence-based judge sees it done.
- [Sub-agents](subagents.md) — read-only researchers, write-capable workers, named custom agents.
- [Diagnostics](diagnostics.md) — the project's typecheck runs after every edit and failures feed back.
- [Scheduling](scheduling.md) — recurring commands through `every` (launchd/systemd/Task Scheduler with run history), never cron; `/loop <when> <prompt>` schedules headless aerin runs; `-p --output-format text|json`.

## Context & memory
- [Compaction](compaction.md) — token-budgeted tail plus an iteratively-updated structured summary.
- [Spill files](spill-files.md) — truncated tool output saved in full for grep/slicing.
- [Session search](session-search.md) — episodic recall over this project's past conversations.
- [Memory](memory.md) — durable facts saved to AGENTS.md's `## Memory` section.
- [Sessions](sessions.md) — JSONL persistence, `--continue`/`--resume`/`/resume`.

## Models & providers
- [Model families](model-families.md) — per-family system-prompt addenda resolved at request time.
- [Provider failover](provider-failover.md) — `fallbackModels` chains for rate limits, outages, spent quotas.

## Integration & extension
- [MCP](mcp.md) — connecting Model Context Protocol servers.
- [Deferred MCP tools](deferred-mcp-tools.md) — tool_search/describe/call bridges when schemas would flood context.
- [Skills & custom commands](skills-and-commands.md) — instruction packs and prompt templates, Claude Code-compatible.
- [Tools](tools.md) — the built-in tool reference.
- [Configuration](configuration.md) — every config key in one place.
