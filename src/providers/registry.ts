import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import type { AerinConfig } from "../config/config.js";

export interface ProviderMeta {
  name: string;
  envVar: string | undefined;
  needsKey: boolean;
}

export const PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", needsKey: true },
  openai: { name: "OpenAI", envVar: "OPENAI_API_KEY", needsKey: true },
  google: { name: "Google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY", needsKey: true },
  openrouter: { name: "OpenRouter", envVar: "OPENROUTER_API_KEY", needsKey: true },
  xai: { name: "xAI", envVar: "XAI_API_KEY", needsKey: true },
  ollama: { name: "Ollama (local)", envVar: undefined, needsKey: false },
};

/** Config provider entries that aren't built in but declare a baseURL —
 *  served through the OpenAI-compatible adapter (DeepSeek, Kimi, Groq,
 *  LM Studio, vLLM, ...). */
export function customProviders(config: AerinConfig): string[] {
  return Object.entries(config.providers ?? {})
    .filter(([name, p]) => !PROVIDERS[name] && Boolean(p.baseURL))
    .map(([name]) => name);
}

export function resolveApiKey(provider: string, config: AerinConfig): string | undefined {
  const meta = PROVIDERS[provider];
  const fromEnv = meta?.envVar ? process.env[meta.envVar] : undefined;
  return fromEnv ?? config.providers?.[provider]?.apiKey;
}

/** Usable providers: built-ins with a key, plus custom baseURL entries. */
export function providersWithKeys(config: AerinConfig): string[] {
  const builtin = Object.keys(PROVIDERS).filter((p) => PROVIDERS[p]?.needsKey && resolveApiKey(p, config));
  return [...builtin, ...customProviders(config)];
}

/**
 * Resolve "provider/model-id" to an AI SDK LanguageModel.
 * Keys come from env vars first, then config. Ollama needs no key.
 */
export function resolveModel(fullId: string, config: AerinConfig): LanguageModel {
  const slash = fullId.indexOf("/");
  if (slash < 1) {
    throw new Error(
      `Model must be "provider/model-id" (e.g. anthropic/claude-opus-4-8), got: ${fullId}`,
    );
  }
  const provider = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const apiKey = resolveApiKey(provider, config);
  const baseURL = config.providers?.[provider]?.baseURL;
  const headers = config.providers?.[provider]?.headers;

  const requireKey = (): string => {
    if (!apiKey) {
      const envVar = PROVIDERS[provider]?.envVar;
      throw new Error(
        `No API key for ${provider}. Set ${envVar ?? "an API key"} or add providers.${provider}.apiKey to your config.`,
      );
    }
    return apiKey;
  };

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}), ...(headers ? { headers } : {}) })(modelId);
    case "openai":
      return createOpenAI({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}), ...(headers ? { headers } : {}) })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}), ...(headers ? { headers } : {}) })(modelId);
    case "openrouter":
      return createOpenRouter({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}), ...(headers ? { headers } : {}) })(modelId);
    case "xai":
      return createXai({ apiKey: requireKey(), ...(baseURL ? { baseURL } : {}), ...(headers ? { headers } : {}) })(modelId);
    case "ollama":
      return createOpenAICompatible({
        name: "ollama",
        baseURL: baseURL ?? "http://localhost:11434/v1",
        ...(headers ? { headers } : {}),
      })(modelId);
    default: {
      // Custom provider: any config entry with a baseURL is routable. Default
      // wire protocol is OpenAI-compatible; set providers.<name>.protocol to
      // "anthropic" for endpoints that speak the Anthropic Messages API
      // instead. Key optional (local servers).
      if (baseURL) {
        const protocol = config.providers?.[provider]?.protocol ?? "openai";
        if (protocol === "anthropic") {
          return createAnthropic({
            baseURL,
            ...(apiKey ? { apiKey } : {}),
            ...(headers ? { headers } : {}),
          })(modelId);
        }
        return createOpenAICompatible({
          name: provider,
          baseURL,
          ...(apiKey ? { apiKey } : {}),
          ...(headers ? { headers } : {}),
        })(modelId);
      }
      throw new Error(
        `Unknown provider "${provider}". Built in: ${Object.keys(PROVIDERS).join(", ")} — or add ` +
          `a custom one to config: {"providers": {"${provider}": {"baseURL": "https://...", "apiKey": "...", ` +
          `"protocol": "openai" | "anthropic", "headers": {...}}}} (protocol defaults to "openai").`,
      );
    }
  }
}
