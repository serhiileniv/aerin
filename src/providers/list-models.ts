import type { AerinConfig } from "../config/config.js";
import { customProviders, resolveApiKey, PROVIDERS } from "./registry.js";
import { catalogEntry, PROVIDER_CATALOG } from "./catalog.js";
import { knownModelInfo } from "./models.js";
import { primeModelsDev } from "./modelsdev.js";

/**
 * Live model discovery: query each provider's models endpoint for whatever
 * the user's key can actually access. Nothing is hardcoded — the static
 * models.dev registry supplies pricing/context metadata for models we recognize.
 * Providers without a configured key are skipped; failures degrade to
 * warnings, never crashes.
 */

export interface DiscoveredModel {
  /** Full id usable everywhere: "provider/model-id" */
  id: string;
  provider: string;
  contextWindow?: number;
  /** USD per million tokens, when the provider's list API exposes it. */
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Short annotation shown in the picker, e.g. "free tier". */
  note?: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  warnings: string[];
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

type Bare = Omit<DiscoveredModel, "provider">;
type Lister = (config: AerinConfig) => Promise<Bare[] | undefined>;

const listers: Record<string, Lister> = {
  async anthropic(config) {
    const key = resolveApiKey("anthropic", config);
    if (!key) return undefined;
    const data = (await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    })) as { data?: { id: string; max_input_tokens?: number }[] };
    return (data.data ?? []).map((m) => ({
      id: m.id,
      ...(m.max_input_tokens ? { contextWindow: m.max_input_tokens } : {}),
    }));
  },

  async openai(config) {
    const key = resolveApiKey("openai", config);
    if (!key) return undefined;
    const data = (await fetchJson("https://api.openai.com/v1/models", {
      Authorization: `Bearer ${key}`,
    })) as { data?: { id: string }[] };
    // The OpenAI list includes embeddings/audio/etc — keep chat-capable families.
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o[0-9]|chatgpt)/.test(id) && !/embedding|audio|tts|whisper|image|dall-e|realtime|transcribe/.test(id))
      .map((id) => ({ id }));
  },

  async google(config) {
    const key = resolveApiKey("google", config);
    if (!key) return undefined;
    const data = (await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`,
    )) as { models?: { name: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number }[] };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .filter((m) => !/embedding|aqa|tts|image/.test(m.name))
      .map((m) => ({
        id: m.name.replace(/^models\//, ""),
        ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}),
      }));
  },

  async openrouter(config) {
    const key = resolveApiKey("openrouter", config);
    if (!key) return undefined; // listing works keyless, but showing models you can't call is noise
    const data = (await fetchJson("https://openrouter.ai/api/v1/models")) as {
      data?: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[];
    };
    return (data.data ?? []).map((m) => {
      const inPrice = m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : undefined;
      const outPrice = m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : undefined;
      return {
        id: m.id,
        ...(m.context_length ? { contextWindow: m.context_length } : {}),
        ...(inPrice !== undefined && Number.isFinite(inPrice) ? { inputPerMTok: inPrice } : {}),
        ...(outPrice !== undefined && Number.isFinite(outPrice) ? { outputPerMTok: outPrice } : {}),
      };
    });
  },

  async xai(config) {
    const key = resolveApiKey("xai", config);
    if (!key) return undefined;
    const data = (await fetchJson("https://api.x.ai/v1/models", {
      Authorization: `Bearer ${key}`,
    })) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => ({ id: m.id }));
  },

  async ollama(config) {
    const baseURL = config.providers?.["ollama"]?.baseURL ?? "http://localhost:11434/v1";
    const root = baseURL.replace(/\/v1\/?$/, "");
    try {
      const data = (await fetchJson(`${root}/api/tags`)) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => ({ id: m.name }));
    } catch {
      return undefined; // Ollama simply not running — not a warning-worthy failure
    }
  },
};

/**
 * Fast startup probe: first locally installed Ollama model as "ollama/<name>",
 * or undefined if Ollama isn't running. Short timeout — this runs on every
 * keyless startup and must not stall it.
 */
export async function detectOllamaModel(config: AerinConfig): Promise<string | undefined> {
  const baseURL = config.providers?.["ollama"]?.baseURL ?? "http://localhost:11434/v1";
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { models?: { name: string }[] };
    const name = data.models?.[0]?.name;
    return name ? `ollama/${name}` : undefined;
  } catch {
    return undefined;
  }
}

function customListerFor(name: string): Lister {
  return async (cfg) => {
    const entry = cfg.providers?.[name];
    const baseURL = entry?.baseURL;
    if (!baseURL) return undefined;
    const key = entry?.apiKey;
    const root = baseURL.replace(/\/$/, "");
    const url =
      entry?.protocol === "anthropic" ? `${root}/models?limit=100` : `${root}/models`;
    const authHeaders: Record<string, string> = {};
    if (key) {
      if (entry?.protocol === "anthropic") {
        authHeaders["x-api-key"] = key;
        authHeaders["anthropic-version"] = "2023-06-01";
      } else {
        authHeaders["Authorization"] = `Bearer ${key}`;
      }
    }
    const data = (await fetchJson(url, { ...authHeaders, ...entry?.headers })) as {
      data?: { id: string }[];
    };
    return (data.data ?? []).map((m) => ({ id: m.id }));
  };
}

/**
 * Query ONE provider's model list — used to validate a freshly pasted key.
 * Throws on HTTP errors (e.g. 401 for a wrong key); resolves undefined when
 * the provider has no key/baseURL configured.
 */
export async function listProviderModels(
  provider: string,
  config: AerinConfig,
): Promise<{ id: string }[] | undefined> {
  const lister =
    listers[provider] ?? (config.providers?.[provider]?.baseURL ? customListerFor(provider) : undefined);
  if (!lister) return undefined;
  return (await lister(config)) ?? undefined;
}

export async function discoverModels(config: AerinConfig): Promise<DiscoveryResult> {
  const models: DiscoveredModel[] = [];
  const warnings: string[] = [];

  // Pricing/context metadata from models.dev (cached daily; silent on failure).
  await primeModelsDev([
    ...new Set([...Object.keys(PROVIDERS), ...PROVIDER_CATALOG.map((e) => e.id), ...customProviders(config)]),
  ]).catch(() => 0);

  // Custom OpenAI-compatible providers: query <baseURL>/models like OpenAI.
  const customListers: Record<string, Lister> = {};
  for (const name of customProviders(config)) {
    customListers[name] = customListerFor(name);
  }

  await Promise.all(
    Object.entries({ ...listers, ...customListers }).map(async ([provider, list]) => {
      try {
        const bare = await list(config);
        if (!bare) return; // no key / not running — silently skipped
        for (const m of bare) {
          const fullId = `${provider}/${m.id}`;
          const known = knownModelInfo(fullId);
          // An agent needs tool calling — hide models the registry marks as
          // incapable (whisper, TTS, guard classifiers). Unknown = keep.
          if (known?.toolCall === false) continue;
          // "free" is shown only for genuinely $0 pricing (formatModelLabel);
          // provider-level free tiers are indicated in /connect and the meter.
          models.push({
            ...m,
            id: fullId,
            provider,
            contextWindow: m.contextWindow ?? known?.contextWindow,
            inputPerMTok: m.inputPerMTok ?? known?.inputPerMTok,
            outputPerMTok: m.outputPerMTok ?? known?.outputPerMTok,
          });
        }
      } catch (err) {
        warnings.push(`${provider}: model list unavailable (${err instanceof Error ? err.message : err})`);
      }
    }),
  );

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, warnings };
}

export function formatModelLabel(m: DiscoveredModel, opts?: { stripProvider?: boolean }): string {
  const name = opts?.stripProvider ? m.id.slice(m.provider.length + 1) : m.id;
  const parts = [name];
  if (m.contextWindow) {
    parts.push(m.contextWindow >= 1_000_000 ? `${(m.contextWindow / 1e6).toFixed(0)}M ctx` : `${Math.round(m.contextWindow / 1000)}k ctx`);
  }
  if (m.inputPerMTok !== undefined && m.outputPerMTok !== undefined) {
    parts.push(m.inputPerMTok === 0 && m.outputPerMTok === 0 ? "free" : `$${trim(m.inputPerMTok)}/$${trim(m.outputPerMTok)}`);
  }
  if (m.note) parts.push(m.note);
  return parts.join("  ·  ");
}

function trim(n: number): string {
  return n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2);
}
