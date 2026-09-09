# Spec: Deferred MCP tools

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/deferred-mcp-tools.md · Source: src/core/deferred-tools.ts (`estimateToolTokens`, `shouldDeferMcpTools`, `createDeferredToolBridge`), src/core/agent.ts (`dispatchToolCall` bridge translation, `summarizeCall`, `AgentOptions.deferredTools`), src/cli.ts (activation + startup notice), src/config/config.ts (`deferMcpTools`) · Tests: test/deferred-tools.test.ts

## Goal

MCP servers can expose dozens of tools whose JSON schemas would be re-sent on every request. When
those schemas would cost more than 10% of the model's context window, withhold them and expose
three small bridge tools instead — `tool_search`, `tool_describe`, `tool_call` — so the model pays
a few hundred tokens of bridge plus one extra round trip per real use. "Done" means: deferral
activates automatically past the threshold (or by config), the bridge finds/describes/invokes the
hidden tools, and calling through the bridge is security-equivalent to calling the tool directly.

## Non-goals

- Not applied to built-in tools; only the `ToolDef`s returned by `startMcpServers` are deferrable.
- No semantic search: `tool_search` is keyword scoring over name + description.
- No per-server or partial deferral: either all MCP tools are deferred or none.
- The threshold is not re-evaluated after `/model` (see known gaps).

## Constraints

- Line budget: `deferred-tools.ts` is 126 lines; the agent-side intercept is ~20 lines.
- Flat tool schemas with primitive types: `tool_call.args` is a **string** holding JSON, because a
  free-form object property breaks Google/OpenAI/Ollama schema handling.
- Layering: no UI imports; the bridge is ordinary `ToolDef`s and the agent loop emits ordinary
  events.
- Security: permission tiers, deny rules, hooks, doom-loop tracking and undo must see the real
  tool, never the bridge.

## Design

### Activation — `shouldDeferMcpTools(defs, modelId, configured)`

```
if defs.length === 0            → false          // never with zero tools, even if configured true
if configured !== undefined     → configured     // "deferMcpTools": true|false forces it
else estimateToolTokens(defs) > modelInfo(modelId).contextWindow * DEFER_FRACTION (0.1)
```

`estimateToolTokens` = `ceil(Σ (name.length + description.length + JSON.stringify(rawSchema).length) / 4)`,
where `rawSchemaOf(def)` reads `.jsonSchema` off the AI SDK `jsonSchema()` wrapper (or `{}`).
`modelInfo` falls back to `DEFAULT_MODEL_INFO.contextWindow = 200_000` for unknown ids, so the default
threshold is 20k tokens (~80k chars). `config.deferMcpTools` is `z.boolean().optional()`, project
value overriding global. Evaluated once in `setupAgent` with the startup `modelId`.

When active, `cli.ts` pushes a warning:
`<n> MCP tools deferred behind tool_search (~<k>k tokens of schemas kept out of context). "deferMcpTools": false disables.`

### The bridge — `createDeferredToolBridge(deferred): { bridgeTools, byName }`

`byName = Map<name, ToolDef>` over the deferred defs; passed to `Agent` as `opts.deferredTools`.

| Tool | Tier | Input | Behaviour |
|---|---|---|---|
| `tool_search` | read | `query: string` | Lowercase, split on whitespace, keep terms with ≥2 chars. Score each deferred def by how many terms appear in `name + " " + description` (lowercased); with no terms every def matches. Sort by hits desc, take 25, print `- <name>: <description whitespace-collapsed, ≤140 chars>`; `(<n> more — refine the query)` when over 25; `No deferred tools match "<q>"…` when none. Ends with `Next: tool_describe for input details, then tool_call.` Summary `ToolSearch(<query>)`. |
| `tool_describe` | read | `name: string` | `<name>\n<description>\n\nInput schema (pass matching JSON to tool_call as the args string):\n<JSON.stringify(raw, null, 2).slice(0, 4000)>`; unknown → `No deferred tool named "<name>". Use tool_search to find the right name.` Summary `ToolDescribe(<name>)`. |
| `tool_call` | execute | `name: string`, `args: string` (JSON object string, `"{}"` if none) | Schema and description only. `execute()` throws `tool_call must be dispatched by the agent loop, never executed directly.` Summary `ToolCall(<name>)`. |

The bridge's descriptions state the deferred count and that permissions apply as if called directly.

### Translation in `Agent.dispatchToolCall` — before anything else

```
if call.toolName === "tool_call" && opts.deferredTools?.size > 0:
  realName = typeof input.name === "string" ? input.name : ""
  if !deferredTools.has(realName):
      return error `Unknown deferred tool: "<realName>". Use tool_search to find available tools.`
  args = {}
  if typeof input.args === "string" && input.args.trim():
      try JSON.parse else return error `tool_call args must be a JSON object string. Got: <first 200 chars>`
  else if input.args is an object: args = input.args        // some models send the object directly
  call = { toolCallId: call.toolCallId, toolName: realName, input: args }
def = toolsByName.get(call.toolName) ?? deferredTools.get(call.toolName)
```

From this point the pipeline is the normal one on the **real** tool: no zod validation (MCP defs have
no `safeParse`), `summarize` → `tool-call` event with `name: realName`, doom-loop tracking on the real
name and args, `targetFor(realName, args)` and `tierFor ?? permission` (execute), `policy.decide` →
deny rules like `mcp__srv__*` fire, pre-hook keyed on the real name, permission prompt showing
`Mcp(server.tool)`, "always allow" persisting `ruleFor` = real name, shadow-git snapshot, execute,
post-hook.

What stays on the bridge: the caller in `send()` still holds the original `call`, so the `tool-result`
**event** and the stored tool message use `toolCallId` and `toolName: "tool_call"` — the assistant's
`tool_call` invocation and its result pair up for provider message validation. `summarizeCall()`
(used for transcript replay) looks in `deferredTools` too, so a replayed real name still summarises.

## Invariants

- Deferral activates only above 10% of the context window, or when forced; never with zero tools —
  `test/deferred-tools.test.ts` ("defers only when schemas would exceed 10%", "config forces it
  either way, but never with zero tools").
- `tool_search` matches by keyword and lists everything on an empty query —
  `test/deferred-tools.test.ts` ("search finds by keyword, lists all on empty query").
- `tool_describe` returns the raw JSON schema and points unknown names at `tool_search` —
  `test/deferred-tools.test.ts`.
- `tool_call` is execute-tier and its own `execute` always throws — `test/deferred-tools.test.ts`
  ("tool_call is execute-tier and never runs its own execute").
- Dispatch through the bridge emits `tool-call` with the real name and runs the real tool with the
  parsed args — `test/deferred-tools.test.ts` ("dispatches the real tool with parsed args").
- Deny rules on the real name block bridge calls — `test/deferred-tools.test.ts` ("deny rules on the
  real tool name still bite through the bridge").
- Unknown names and malformed args return actionable errors, not exceptions —
  `test/deferred-tools.test.ts`.
- Deferred schemas never enter `buildToolSet()` — holds by construction (deferred defs are not in
  `opts.tools`), untested.
- `args` sent as an object is accepted — untested.
- The stored tool message keeps `toolName: "tool_call"` paired with the bridge `toolCallId` — untested.

## Acceptance criteria

1. Above-threshold schemas defer; below-threshold do not; `estimateToolTokens` reflects ~4 chars/token —
   test/deferred-tools.test.ts.
2. `deferMcpTools: true|false` forces the decision; zero tools never defer — test/deferred-tools.test.ts.
3. `tool_search` keyword hit / miss / empty-query behaviour — test/deferred-tools.test.ts.
4. `tool_describe` schema output and unknown-name hint — test/deferred-tools.test.ts.
5. `tool_call.permission === "execute"` and its `execute` rejects — test/deferred-tools.test.ts.
6. `tool_call` → real tool: `tool-call` event carries the real name; the result is the real output —
   test/deferred-tools.test.ts.
7. Deny rule on the real name produces a "Denied by permission rule" result through the bridge —
   test/deferred-tools.test.ts.
8. Malformed `args` → "JSON object string" error; unknown name → "tool_search" hint —
   test/deferred-tools.test.ts.
9. `args` given as an object (not a string) is accepted — **gap**.
10. "Always allow" from a bridge call persists a rule on the real tool name — **gap**.
11. Doom-loop tracking counts repeated bridge calls by real name + args — **gap**.
12. The startup notice reports the count and saved tokens — **gap**.
13. `tool_search` caps at 25 results with a "more" hint — **gap**.
14. Transcript replay summarises deferred tool calls via `summarizeCall` — **gap**.

## Open questions / known gaps

- The threshold uses the startup model's context window; switching to a smaller-context model with
  `/model` does not re-evaluate, and vice versa.
- `tool_describe` silently truncates schemas at 4000 chars with no marker.
- The `tool-result` event's `name` is `tool_call` while the matching `tool-call` event's `name` is the
  real tool; frontends pair by `id`, so this is invisible today but is an asymmetry in the contract.
- `tool_search` scoring is substring-based over name and description only; server names inside the
  `mcp__<server>__` prefix count as text, which is usually helpful but unranked.
- All-or-nothing: a single huge server forces every server's tools behind the bridge.
- `deferMcpTools: true` with a tiny tool set costs an extra round trip for no context benefit — the
  config exists for testing and for users who prefer a lean tool list.

## Decisions

- 2026-07-23 (e7fc7af, v0.0.100): adopt Hermes's bridge-tool pattern (search/describe/call) with its
  10% threshold rather than trimming descriptions or dropping servers — it keeps every tool reachable
  at a fixed, small cost.
- 2026-07-23 (e7fc7af): translate `tool_call` into the real tool **inside `dispatchToolCall`, before
  permissions**, instead of letting `tool_call.execute` forward — so deny rules, allow-always, hooks,
  undo and doom-loop all key on the real name (source comment; the docs call this "the
  security-critical detail").
- 2026-07-23 (e7fc7af): `args` is a JSON string, not an object, to keep the bridge schema flat for
  providers with JSON-Schema quirks; objects are still accepted defensively because some models send
  them anyway.
- 2026-07-23 (e7fc7af): keep the transcript pairing on the bridge call id/name so provider-side
  message validation (assistant `tool_call` ↔ tool result) never breaks.
- 2026-07-23 (09496c9, v0.0.104): doom-loop tracking placed after the bridge remap so repeated MCP
  calls are compared by real name (per AGENTS.md).
