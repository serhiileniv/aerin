import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GLOBAL_CONFIG_FILE, projectSettingsFile } from "./paths.js";

const mcpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);

const providerSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  /** Extra request headers — auth schemes beyond a plain Bearer key, org/tenant ids, etc. */
  headers: z.record(z.string()).optional(),
  /** Wire protocol for a custom (non-built-in) provider name. Default: openai-compatible. */
  protocol: z.enum(["openai", "anthropic"]).optional(),
});

export const configSchema = z.object({
  model: z.string().optional(),
  /** Optional cheaper model for the agent (sub-agent) tool, e.g. "anthropic/claude-haiku-4-5". */
  subagentModel: z.string().optional(),
  /** Maintained automatically: last models picked with /model, newest first. */
  recentModels: z.array(z.string()).optional(),
  /**
   * Shell hooks: {"pre:bash": "...", "post:edit": "bun run typecheck", "post:*": "..."}.
   * Exit-code semantics by default; print a JSON object to use the structured
   * protocol (pre: {"decision","reason","input"}, post: {"context"}). Lifecycle
   * keys use the same map: session:start, prompt:submit, turn:end, compact:pre,
   * session:end — see core/hooks.ts and docs/hooks.md.
   */
  hooks: z.record(z.string()).optional(),
  /** Post-edit check command; false disables (default: auto-detect a "typecheck" script). */
  diagnostics: z.union([z.string(), z.literal(false)]).optional(),
  /** Force MCP tool deferral on/off (default: auto when schemas would eat >10% of context). */
  deferMcpTools: z.boolean().optional(),
  /** Ordered "provider/model" ids tried when the active model fails (rate limit, outage, spent quota). */
  fallbackModels: z.array(z.string()).optional(),
  providers: z.record(providerSchema).optional(),
  mcpServers: z.record(mcpServerSchema).optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      /** Same rule syntax; beats allow rules, accept mode and --yolo. */
      deny: z.array(z.string()).default([]),
    })
    .optional(),
});

export type AerinConfig = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const DEFAULT_MODEL = "anthropic/claude-opus-4-8";

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Failed to parse ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

export interface LoadedConfig {
  config: AerinConfig;
  globalConfig: AerinConfig;
  projectConfig: AerinConfig;
}

/** Merge order: global <- project <- CLI flags (flags applied by caller). */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const globalRaw = (await readJsonIfExists(GLOBAL_CONFIG_FILE)) ?? {};
  const projectRaw = (await readJsonIfExists(projectSettingsFile(cwd))) ?? {};
  const globalConfig = configSchema.parse(globalRaw);
  const projectConfig = configSchema.parse(projectRaw);

  const config: AerinConfig = {
    model: projectConfig.model ?? globalConfig.model,
    subagentModel: projectConfig.subagentModel ?? globalConfig.subagentModel,
    recentModels: globalConfig.recentModels,
    hooks: { ...globalConfig.hooks, ...projectConfig.hooks },
    ...(projectConfig.diagnostics ?? globalConfig.diagnostics) !== undefined
      ? { diagnostics: projectConfig.diagnostics ?? globalConfig.diagnostics }
      : {},
    ...(projectConfig.deferMcpTools ?? globalConfig.deferMcpTools) !== undefined
      ? { deferMcpTools: projectConfig.deferMcpTools ?? globalConfig.deferMcpTools }
      : {},
    ...(projectConfig.fallbackModels ?? globalConfig.fallbackModels)
      ? { fallbackModels: projectConfig.fallbackModels ?? globalConfig.fallbackModels }
      : {},
    providers: { ...globalConfig.providers, ...projectConfig.providers },
    mcpServers: { ...globalConfig.mcpServers, ...projectConfig.mcpServers },
    permissions: {
      allow: [
        ...(globalConfig.permissions?.allow ?? []),
        ...(projectConfig.permissions?.allow ?? []),
      ],
      deny: [
        ...(globalConfig.permissions?.deny ?? []),
        ...(projectConfig.permissions?.deny ?? []),
      ],
    },
  };
  return { config, globalConfig, projectConfig };
}

/**
 * Remember an interactively chosen model: becomes the default for the next
 * session and heads the picker's Recent section. Global config only — an
 * explicit -m flag or project setting still wins for one-off runs.
 */
export async function persistModelChoice(modelId: string, file: string = GLOBAL_CONFIG_FILE): Promise<void> {
  const raw = ((await readJsonIfExists(file)) ?? {}) as Record<string, unknown>;
  raw["model"] = modelId;
  const recent = Array.isArray(raw["recentModels"]) ? (raw["recentModels"] as string[]) : [];
  raw["recentModels"] = [modelId, ...recent.filter((m) => m !== modelId)].slice(0, 5);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

/** Save a provider API key (and optional baseURL/protocol) to the global config. */
export async function persistProviderKey(
  provider: string,
  apiKey: string,
  baseURL?: string,
  protocol?: "openai" | "anthropic",
  file: string = GLOBAL_CONFIG_FILE,
): Promise<void> {
  const raw = ((await readJsonIfExists(file)) ?? {}) as Record<string, unknown>;
  const providers = (raw["providers"] ?? {}) as Record<string, Record<string, unknown>>;
  providers[provider] = {
    ...providers[provider],
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(protocol ? { protocol } : {}),
  };
  raw["providers"] = providers;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

/** Append a permission rule to the project settings file. */
export async function persistProjectRule(cwd: string, rule: string): Promise<void> {
  const file = projectSettingsFile(cwd);
  const raw = ((await readJsonIfExists(file)) ?? {}) as Record<string, unknown>;
  const perms = (raw["permissions"] ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(perms["allow"]) ? (perms["allow"] as string[]) : [];
  if (!allow.includes(rule)) allow.push(rule);
  raw["permissions"] = { ...perms, allow };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
}
