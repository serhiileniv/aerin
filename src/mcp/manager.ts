import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema } from "ai";
import type { z } from "zod";
import type { McpServerConfig } from "../config/config.js";
import type { ToolDef } from "../tools/types.js";
import { truncateOutput } from "../tools/types.js";
import { VERSION } from "../version.js";

const CONNECT_TIMEOUT_MS = 15_000;

export interface McpConnection {
  serverName: string;
  client: Client;
  tools: ToolDef[];
}

export interface McpStartResult {
  connections: McpConnection[];
  warnings: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Connect to configured MCP servers and wrap their tools as ToolDefs named
 * `mcp__<server>__<tool>`. A server that fails to start produces a warning,
 * not a crash — the agent runs without it.
 */
export async function startMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpStartResult> {
  const connections: McpConnection[] = [];
  const warnings: string[] = [];

  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      try {
        const client = new Client({ name: "aerin", version: VERSION });
        const transport =
          "url" in cfg
            ? new StreamableHTTPClientTransport(new URL(cfg.url), {
                requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
              })
            : new StdioClientTransport({
                command: cfg.command,
                args: cfg.args ?? [],
                env: { ...(process.env as Record<string, string>), ...cfg.env },
                stderr: "ignore",
              });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP server "${name}"`);
        const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP listTools "${name}"`);
        const tools = listed.tools.map((t) => wrapMcpTool(name, client, t.name, t.description ?? "", t.inputSchema));
        connections.push({ serverName: name, client, tools });
      } catch (err) {
        warnings.push(`MCP server "${name}" unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  return { connections, warnings };
}

function wrapMcpTool(
  serverName: string,
  client: Client,
  toolName: string,
  description: string,
  rawSchema: unknown,
): ToolDef {
  const namespaced = `mcp__${serverName}__${toolName}`;
  return {
    name: namespaced,
    description: `[${serverName}] ${description}`,
    // JSON Schema passthrough for the model; local zod validation is skipped for MCP tools.
    inputSchema: jsonSchema(rawSchema as Parameters<typeof jsonSchema>[0]) as unknown as z.ZodTypeAny,
    permission: "execute",
    summarize: () => `Mcp(${serverName}.${toolName})`,
    async execute(input) {
      const result = await client.callTool({ name: toolName, arguments: input as Record<string, unknown> });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
        .join("\n");
      if (result.isError) throw new Error(text || "MCP tool returned an error");
      return truncateOutput(text || "(empty result)");
    },
  };
}

export async function stopMcpServers(connections: McpConnection[]): Promise<void> {
  await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
}
