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

## New providers and models require no code changes

Three layers, each solving a different piece of "aerin doesn't know about this yet":

1. **New models on a provider you're already connected to** — `/model` and `/connect` query the provider's own `/models` endpoint live (`providers/list-models.ts`), every time the picker opens. A provider shipping a new model shows up on your next `/model`, nothing to update.
2. **A provider not yet curated, but present in [models.dev](https://models.dev)** — `/connect`'s picker has an "All providers — models.dev" section (`providers/modelsdev.ts`) sourced from that community registry (173+ entries at last count, refreshed daily), covering anything reachable through the OpenAI-compatible or Anthropic Messages protocol. No code change, no aerin release needed for a provider to appear there — it appears the day models.dev lists it.
3. **Anything else** — `/connect`'s "Custom endpoint…" flow (or hand-editing `providers.<name>` in config) takes any `baseURL` + `protocol` + `headers`, curated or not.

`src/providers/catalog.ts`'s `PROVIDER_CATALOG` is only the "featured" shortcut on top of that — providers common enough to deserve a name and a preset `baseURL` instead of the custom-endpoint flow. It's small and hand-picked on purpose (currently: the 5 native SDKs, major OpenAI-compatible platforms, and several Chinese providers — Alibaba/Qwen, SiliconFlow, Volcengine/Doubao, StepFun, SenseNova, Tencent Hunyuan, MiniMax); everything else routes through layers 2 and 3 automatically.
