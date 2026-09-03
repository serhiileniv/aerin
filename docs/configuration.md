# Configuration

Source: `src/config/config.ts`. Two files, merged global ← project: the global config (`config.json` in the aerin config dir) and `.aerin/settings.json` in the project. Never put API keys in the project file — it gets committed; use env vars, the global config, or `/connect`.

| Key | Type | What it does |
|---|---|---|
| `model` | string | `provider/model-id` to use; aerin never auto-selects a paid model |
| `subagentModel` | string | Cheaper model for sub-agents and the goal-loop judge |
| `fallbackModels` | string[] | Ordered [failover chain](provider-failover.md) |
| `providers` | record | `{ apiKey?, baseURL?, headers?, protocol? }` per provider; any name with a `baseURL` is routable — `protocol: "anthropic"` speaks the Anthropic Messages API instead of the default OpenAI-compatible one, and `headers` adds/overrides request headers (non-Bearer auth, org/tenant ids) |
| `mcpServers` | record | [MCP servers](mcp.md), stdio or HTTP |
| `deferMcpTools` | boolean | Force [deferral](deferred-mcp-tools.md) on/off (default: auto at >10% of context) |
| `permissions.allow` | string[] | [Allow rules](permissions.md) — `bash(git *)`, `write(src/*)`, `mcp__github__*` |
| `permissions.deny` | string[] | Deny rules — beat allow/accept/`--yolo`; match chained bash segments |
| `hooks` | record | `"pre:<tool>"`/`"post:<tool>"` shell commands — [hooks](hooks.md) |
| `diagnostics` | string \| false | Post-edit check command; false disables; unset auto-detects a `typecheck` script — [diagnostics](diagnostics.md) |
| `recentModels` | string[] | Maintained automatically by `/model` |

CLI flags that interact: `--yolo` (auto-approve everything not denied), `--allow-outside-cwd`, `-m/--model`, `--continue`, `--resume <id>`, `--no-tui`, `-p` (headless print).

## Connecting an Anthropic-Messages-shaped or oddly-authenticated endpoint

`protocol`/`headers` only apply to provider names outside the built-ins (`anthropic`, `openai`, `google`, `openrouter`, `xai`, `ollama`) — those already speak their native protocol.

```json
{
  "providers": {
    "mygateway": {
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "sk-...",
      "protocol": "anthropic",
      "headers": { "x-tenant-id": "acme" }
    }
  }
}
```

`/connect <provider> <api-key> [baseURL] [openai|anthropic]` sets `protocol` interactively too (`headers` stays config-file-only — not worth a multi-key-value prompt).
