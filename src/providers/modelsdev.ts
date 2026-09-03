import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config/paths.js";
import { registerModelInfo } from "./models.js";

/**
 * models.dev integration: a community registry of provider/model metadata
 * (pricing per MTok, context windows) — the same source opencode uses.
 * Fetched once a day, cached on disk, applied best-effort: failures are
 * silent and aerin just shows less pricing info.
 */

const API_URL = "https://models.dev/api.json";
const CACHE_FILE = path.join(DATA_DIR, "models-dev-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** aerin provider id -> models.dev provider id candidates. */
const PROVIDER_ALIASES: Record<string, string[]> = {
  moonshot: ["moonshot", "moonshotai"],
  zai: ["zai", "zhipuai", "z-ai"],
  // Same registry entry as "zai" above — the China domestic front door for
  // the same models, so it shares the same pricing/context data.
  "zhipuai-cn": ["zhipuai"],
  lmstudio: ["lmstudio"],
};

interface ModelsDevModel {
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
  tool_call?: boolean;
}
type ModelsDevData = Record<
  string,
  {
    models?: Record<string, ModelsDevModel>;
    name?: string;
    npm?: string;
    api?: string;
    env?: string | string[];
  }
>;

export interface ModelsDevProvider {
  id: string;
  name: string;
  baseURL: string;
  envVar?: string;
  /** Set when the registry lists this provider under the Anthropic adapter — omitted means OpenAI-compatible. */
  protocol?: "anthropic";
}

/** Registry npm adapters aerin can actually speak, mapped to our protocol names. */
const ROUTABLE_NPM: Record<string, "openai" | "anthropic"> = {
  "@ai-sdk/openai-compatible": "openai",
  "@ai-sdk/anthropic": "anthropic",
};

/**
 * Providers from the registry that are safely routable through one of
 * aerin's two generic adapters (OpenAI-compatible or Anthropic Messages —
 * they declare one of those as their npm adapter and expose an API endpoint)
 * — the /connect "all providers" catalog. Registry entries on a dedicated
 * SDK (Cohere, native Mistral/Groq/Cerebras clients, etc.) aren't included:
 * their wire protocol isn't one aerin speaks, so listing them would just be
 * a connect button that always fails.
 */
export function parseProviderCatalog(data: ModelsDevData): ModelsDevProvider[] {
  const out: ModelsDevProvider[] = [];
  for (const [id, p] of Object.entries(data)) {
    const protocol = p.npm ? ROUTABLE_NPM[p.npm] : undefined;
    if (!protocol || !p.api) continue;
    const envVar = Array.isArray(p.env) ? p.env[0] : p.env;
    out.push({
      id,
      name: p.name ?? id,
      baseURL: p.api,
      ...(envVar ? { envVar } : {}),
      ...(protocol === "anthropic" ? { protocol } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function modelsDevProviders(): Promise<ModelsDevProvider[]> {
  const data = await fetchRegistry();
  return data ? parseProviderCatalog(data) : [];
}

async function fetchRegistry(): Promise<ModelsDevData | undefined> {
  try {
    const cachedRaw = await fs.readFile(CACHE_FILE, "utf8");
    const cached = JSON.parse(cachedRaw) as { fetchedAt: number; data: ModelsDevData };
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  } catch {
    // no cache — fetch
  }
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as ModelsDevData;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), data }), "utf8").catch(() => {});
    return data;
  } catch {
    return undefined;
  }
}

/** Register registry metadata under aerin "provider/model-id" naming. Exported for tests. */
export function registerFromRegistry(data: ModelsDevData, providerIds: readonly string[]): number {
  let count = 0;
  for (const aerinId of providerIds) {
    const candidates = PROVIDER_ALIASES[aerinId] ?? [aerinId];
    for (const devId of candidates) {
      const models = data[devId]?.models;
      if (!models) continue;
      for (const [modelId, m] of Object.entries(models)) {
        const contextWindow = m.limit?.context;
        const inputPerMTok = m.cost?.input;
        const outputPerMTok = m.cost?.output;
        // Register even metadata-light entries: a tool_call:false flag alone
        // matters (it keeps whisper/TTS models out of the picker).
        if (!contextWindow && inputPerMTok === undefined && typeof m.tool_call !== "boolean") continue;
        registerModelInfo(`${aerinId}/${modelId}`, {
          contextWindow: contextWindow || 200_000,
          maxOutput: m.limit?.output || 8_192,
          ...(inputPerMTok !== undefined ? { inputPerMTok } : {}),
          ...(outputPerMTok !== undefined ? { outputPerMTok } : {}),
          ...(typeof m.tool_call === "boolean" ? { toolCall: m.tool_call } : {}),
        });
        count++;
      }
      break; // first matching alias wins
    }
  }
  return count;
}

let primed: Promise<number> | undefined;

/**
 * Load the registry and register metadata for every model under the aerin
 * "provider/model-id" naming. Returns how many models were registered.
 * Idempotent — concurrent callers share one fetch.
 */
export function primeModelsDev(providerIds: readonly string[]): Promise<number> {
  primed ??= (async () => {
    const data = await fetchRegistry();
    return data ? registerFromRegistry(data, providerIds) : 0;
  })();
  return primed;
}
