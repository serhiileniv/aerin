# Spec: MCP client

Status: retroactive (written 2026-09-09 for an existing feature)
Doc: docs/mcp.md · Source: src/mcp/manager.ts (`startMcpServers`, `wrapMcpTool`, `stopMcpServers`), src/cli.ts (`setupAgent` MCP block, `teardown`, `--no-mcp`), src/core/session-commands.ts (`mcpCommand`, `statusCommand`), src/config/config.ts (`mcpServerSchema`), src/permissions/policy.ts (`ruleMatches`, `ruleFor`, `targetFor`) · Tests: test/policy.test.ts (mcp rule matching), test/highvalue.test.ts (`mcpCommand`), test/deferred-tools.test.ts (MCP-shaped ToolDef dispatch), test/tui-smoke.test.ts (`--no-mcp`)

## Goal

Let the model use tools from any Model Context Protocol server the user configures, over stdio or
Streamable HTTP, with the same permission gate, undo snapshot, hooks and output truncation as the
built-in tools. "Done" means: configured servers connect at startup, their tools appear to the model
as `mcp__<server>__<tool>`, a server that fails to start degrades to a warning, `/mcp` lists what is
connected, and children are closed on exit.

## Non-goals

- Not an MCP server: aerin only consumes tools. Resources, prompts, sampling and notifications from
  the protocol are not surfaced.
- No local validation of MCP inputs: the server's JSON Schema is passed through to the model and the
  server validates on call.
- No reconnect, health polling, or lazy start; a server is connected once at startup or not at all.
- Context-window protection for large tool sets is the separate
  [deferred MCP tools](deferred-mcp-tools.md) feature.

## Constraints

- No new deps beyond `@modelcontextprotocol/sdk` (already present); no packages with native
  postinstall.
- Layering: `src/mcp/` may not import `ink`/`react`; the only UI-facing surface is the `ToolDef`
  and the `warnings` list returned to `cli.ts`.
- Windows first-class: stdio servers are spawned by the SDK's `StdioClientTransport`; aerin passes
  `command`/`args` verbatim and never builds a `cmd /c` string.
- Line budget: `manager.ts` is 108 lines.

## Design

### Configuration

```
mcpServers: Record<name,
  { command: string; args?: string[]; env?: Record<string,string> }      // stdio
| { url: string (zod .url()); headers?: Record<string,string> }>         // Streamable HTTP
```

`loadConfig` merges `{ ...global.mcpServers, ...project.mcpServers }` — a project server with the same
name replaces the global entry whole. `--no-mcp` (`flags.mcp === false`) skips the block entirely.

### Startup — `startMcpServers(servers): Promise<{ connections, warnings }>`

All servers start concurrently (`Promise.all`). Per server:

1. `new Client({ name: "aerin", version: VERSION })`.
2. Transport: `"url" in cfg` → `StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: cfg.headers ? { headers } : undefined })`;
   otherwise `StdioClientTransport({ command, args: cfg.args ?? [], env: { ...process.env, ...cfg.env }, stderr: "ignore" })`.
3. `withTimeout(client.connect(transport), 15_000, 'MCP server "<name>"')`, then
   `withTimeout(client.listTools(), 15_000, 'MCP listTools "<name>"')`.
4. Each listed tool is wrapped (below); the connection `{ serverName, client, tools }` is recorded.
5. Any throw → `warnings.push('MCP server "<name>" unavailable: <message>')`; no connection.

`CONNECT_TIMEOUT_MS = 15_000` applies separately to connect and to listTools.

### Tool wrapping — `wrapMcpTool(serverName, client, toolName, description, rawSchema): ToolDef`

| Field | Value |
|---|---|
| `name` | `mcp__${serverName}__${toolName}` |
| `description` | `[${serverName}] ${description}` |
| `inputSchema` | `jsonSchema(rawSchema)` from the AI SDK, cast to `ZodTypeAny`. It has no `safeParse`, so `dispatchToolCall` skips local validation and passes `call.input` through. |
| `permission` | `"execute"` |
| `summarize` | `() => \`Mcp(${serverName}.${toolName})\`` (input ignored) |
| `execute` | `client.callTool({ name: toolName, arguments: input })`; `content` parts of `type === "text"` are joined with `\n`, other parts become `[<type> content]`; `result.isError` → `throw new Error(text || "MCP tool returned an error")`; otherwise `truncateOutput(text || "(empty result)")`. |

No `tierFor`, no `preview`, no `onProgress` use.

### Registration (cli.ts)

```
if (flags.mcp && config.mcpServers && keys > 0):
  res = await startMcpServers(config.mcpServers); warnings.push(...res.warnings)
  mcpDefs = connections.flatMap(c => c.tools)
  if shouldDeferMcpTools(mcpDefs, modelId, config.deferMcpTools): register bridge tools, deferredTools = byName
  else: tools.push(...mcpDefs)
```

Warnings are shown by each frontend at startup (print mode: `warning: …` on stderr).

### Permissions, undo, hooks

MCP tools go through the normal `dispatchToolCall` pipeline as execute-tier tools:
`targetFor(name, input)` yields `{ tool: name, target: input.path ?? "" }` (a string `path` argument
becomes the rule target; otherwise the target is empty). Rules: a bare `mcp__github__*` matches on
tool name (`ruleMatches`); "always allow" persists `ruleFor` = the exact tool name for `mcp__*`
tools; deny rules like `mcp__github__delete_*` beat everything. Because the tier is not `read`, the
shadow-git snapshot runs before every MCP call so `/undo` covers its side effects. `pre:`/`post:`
hooks key on the full `mcp__…` name or `*`.

### Listing and teardown

- `/mcp` → `mcpCommand(ctx)`: no connections → `No MCP servers connected. Add them under "mcpServers" in the config (stdio or HTTP).`;
  otherwise `MCP servers:` then one line per server `  <name> — <n> tool(s): <first 8 names with the mcp__<name>__ prefix stripped>[, …]`.
- `/status` prints the connected server names on its `mcp` line; `aerin doctor` lists configured names.
- `teardown(setup)` (every frontend's exit path) runs the `session:end` hook then
  `stopMcpServers(connections)` = `client.close()` for each, errors swallowed. `SIGTERM` exits without
  closing clients (stdio children die with their pipes — comment in `main()`).

## Invariants

- A server that fails to connect or list tools produces a warning and never a crash — untested (no
  test starts a server).
- Tool names are exactly `mcp__<server>__<tool>`, and bare `mcp__<server>__*` rules match them —
  `test/policy.test.ts` (ruleMatches, ruleFor for `mcp__gh__pr`, deny `mcp__github__delete_*`).
- MCP tools are execute-tier and skip local zod validation (JSON-schema passthrough) —
  `test/deferred-tools.test.ts` uses MCP-shaped defs (`{ jsonSchema }`, `permission: "execute"`) and
  dispatches them through `Agent`; the wrapper itself is untested.
- MCP `isError` results become tool errors (thrown) and non-error results are truncated — untested.
- `/mcp` with no connections prints the "No MCP servers connected" hint — `test/highvalue.test.ts`.
- `--no-mcp` starts without touching configured servers — `test/tui-smoke.test.ts` spawns with
  `--no-mcp` (it verifies the app boots, not that servers were skipped).
- Both connect and listTools are bounded by 15 s — untested.

## Acceptance criteria

1. `mcpServers` accepts stdio (`command`, optional `args`/`env`) and HTTP (`url`, optional
   `headers`) entries and rejects other shapes — **gap** (no config test).
2. Each server's tools are registered as `mcp__<server>__<tool>` with description
   `[<server>] …` — **gap**.
3. A failing server yields a startup warning naming it and the reason; the rest of the session
   proceeds — **gap**.
4. Connect and listTools each time out after 15 s with a labelled error — **gap**.
5. MCP tools are execute-tier and ask unless an allow rule matches; deny rules on the real name
   block them, including through the deferred bridge — test/policy.test.ts (rule semantics),
   test/deferred-tools.test.ts ("deny rules on the real tool name still bite through the bridge").
6. `isError` results surface as tool errors; text parts are joined, non-text parts are labelled —
   **gap**.
7. Results pass through `truncateOutput` (spill files apply) — **gap**.
8. `/mcp` lists servers with tool counts and up to 8 bare tool names; prints a hint when none —
   test/highvalue.test.ts (empty case only; populated case is a **gap**).
9. `--no-mcp` skips connecting — test/tui-smoke.test.ts (boot only).
10. Exit closes every client via `teardown` — **gap**.
11. `env` for stdio servers extends `process.env` rather than replacing it — **gap**.

## Open questions / known gaps

- Nothing in `test/` exercises `manager.ts`; the transports, timeout wrapper and result mapping are
  covered only by manual use. A fake stdio server (a Node script speaking MCP) would close criteria
  2–4, 6, 7 and 11.
- `summarize` ignores the input, so the transcript and permission prompt show `Mcp(server.tool)`
  without any argument — unlike built-ins' `Name(args)` form.
- `stderr: "ignore"` on stdio servers hides their diagnostics; a misbehaving server is only
  visible as a timeout or generic error.
- Servers are started before the model is known to be usable and even in print mode; a slow server
  costs up to 30 s of startup (connect + list).
- `targetFor` treats any `path` argument as the rule target, so `mcp__fs__read_file(path)` rules
  can scope by path but tools with different argument names cannot.
- Streamable HTTP only; the older SSE transport is not offered.
- Whether the SDK passes `windowsHide` when spawning stdio servers was not verified.

## Decisions

- 2026-07-22 (5c4aa1f, initial): MCP support shipped in the first version with the
  `mcp__<server>__<tool>` naming (Claude Code's convention) so users' existing allow/deny rules
  transfer.
- 2026-07-22 (5c4aa1f): JSON-schema passthrough instead of converting server schemas to zod — the
  server is the authority on its inputs and conversion would lose or mangle constructs.
- 2026-07-22 (5c4aa1f): a failing server degrades to a warning rather than aborting startup, so one
  broken integration cannot lock the user out of the agent.
- 2026-07-22 (5c4aa1f): all MCP tools are execute-tier; there is no way for a server to declare a
  read-only tool, so the safe default is to ask.
- 2026-07-22 (5c4aa1f): concurrent startup (`Promise.all`) with a 15 s bound per phase — slow
  servers should not serialise.
- 2026-07-22 (5c4aa1f, initial): HTTP servers accept `headers` (passed as `requestInit.headers`)
  from the first version; the provider-level `headers` option added on 2026-09-03 (0222e19) is
  unrelated to MCP.
- 2026-09-09 (ab0a0db): `summarize` changed to the `Mcp(server.tool)` form to fit the
  `Name(args)` transcript grammar from the TUI polish spec.
