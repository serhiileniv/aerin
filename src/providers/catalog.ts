/**
 * Curated connect catalog (opencode-style): providers users can hook up by
 * just picking a name and pasting a key. Built-ins route through their native
 * SDK adapters; entries with a baseURL ride the OpenAI-compatible adapter.
 */
export interface CatalogEntry {
  /** Provider id as used in "provider/model-id" and config.providers. */
  id: string;
  name: string;
  /** Preset endpoint for OpenAI-compatible providers; omit for built-ins. */
  baseURL?: string;
  needsKey: boolean;
  /** Provider offers a usable free tier — surfaced in the model picker. */
  freeTier?: boolean;
  /** Wire protocol when it isn't OpenAI-compatible (e.g. MiniMax speaks Anthropic Messages). */
  protocol?: "openai" | "anthropic";
}

// Entries route through the OpenAI-compatible adapter by default (or the
// Anthropic one when `protocol: "anthropic"`) — see providers/registry.ts.
// Every baseURL/env pairing below is cross-checked against the models.dev
// registry (the same source list-models.ts pulls live metadata from), using
// the SAME id models.dev uses wherever one exists — that gets pricing/context
// metadata for free with no alias wiring. Anything not curated here still
// works: /connect's "All providers — models.dev" list (modelsdev.ts) surfaces
// the rest of that registry automatically, and a fully custom name+baseURL
// entry (optionally with `protocol`/`headers`) covers anything else.
export const PROVIDER_CATALOG: CatalogEntry[] = [
  { id: "anthropic", name: "Anthropic (Claude)", needsKey: true },
  { id: "openai", name: "OpenAI (GPT)", needsKey: true },
  { id: "google", name: "Google (Gemini)", needsKey: true, freeTier: true },
  { id: "openrouter", name: "OpenRouter (300+ models)", needsKey: true },
  { id: "xai", name: "xAI (Grok)", needsKey: true },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", needsKey: true },
  { id: "groq", name: "Groq (fast open models)", baseURL: "https://api.groq.com/openai/v1", needsKey: true, freeTier: true },
  { id: "moonshot", name: "Moonshot (Kimi)", baseURL: "https://api.moonshot.ai/v1", needsKey: true },
  { id: "mistral", name: "Mistral", baseURL: "https://api.mistral.ai/v1", needsKey: true },
  { id: "together", name: "Together AI", baseURL: "https://api.together.xyz/v1", needsKey: true },
  { id: "fireworks", name: "Fireworks AI", baseURL: "https://api.fireworks.ai/inference/v1", needsKey: true },
  { id: "cerebras", name: "Cerebras (ultra fast)", baseURL: "https://api.cerebras.ai/v1", needsKey: true, freeTier: true },
  { id: "zai", name: "Z.ai (GLM)", baseURL: "https://api.z.ai/api/paas/v4", needsKey: true },
  // Same company, domestic endpoint — z.ai is Zhipu's international front
  // door, bigmodel.cn its China one, same split pattern as Alibaba/SiliconFlow
  // above. Zhipu's own registry entry lists two genuinely free models here
  // (glm-4.5-flash, glm-4.7-flash, $0/$0) — aliased in modelsdev.ts so both
  // this entry and "zai" pick up that pricing automatically.
  { id: "zhipuai-cn", name: "Zhipu AI / GLM (China, bigmodel.cn)", baseURL: "https://open.bigmodel.cn/api/paas/v4", needsKey: true },
  { id: "lmstudio", name: "LM Studio (local)", baseURL: "http://localhost:1234/v1", needsKey: false },

  // Chinese model providers — the API landscape most likely to need a name
  // aerin doesn't already know. "-cn" entries are the mainland-China domestic
  // endpoint (often lower latency / no international billing needed); the
  // bare id is the international one where the provider splits the two.
  { id: "alibaba", name: "Alibaba Cloud (Qwen, international)", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", needsKey: true },
  { id: "alibaba-cn", name: "Alibaba Cloud (Qwen, China)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", needsKey: true },
  { id: "siliconflow", name: "SiliconFlow", baseURL: "https://api.siliconflow.com/v1", needsKey: true },
  { id: "siliconflow-cn", name: "SiliconFlow (China)", baseURL: "https://api.siliconflow.cn/v1", needsKey: true },
  { id: "volcengine", name: "Volcengine Ark (ByteDance/Doubao)", baseURL: "https://ark.cn-beijing.volces.com/api/v3", needsKey: true },
  { id: "stepfun", name: "StepFun (China)", baseURL: "https://api.stepfun.com/v1", needsKey: true },
  { id: "sensenova", name: "SenseNova (China)", baseURL: "https://token.sensenova.cn/v1", needsKey: true },
  { id: "tencent-tokenhub", name: "Tencent Hunyuan (TokenHub)", baseURL: "https://tokenhub.tencentmaas.com/v1", needsKey: true },
  // MiniMax speaks the Anthropic Messages API, not OpenAI's — a real-world
  // case for the protocol switch above, not a special case in the code.
  { id: "minimax", name: "MiniMax", baseURL: "https://api.minimax.io/anthropic/v1", needsKey: true, protocol: "anthropic" },

  // Other inference platforms not already covered.
  { id: "novita-ai", name: "Novita AI", baseURL: "https://api.novita.ai/openai", needsKey: true },
  { id: "nebius", name: "Nebius AI Studio", baseURL: "https://api.tokenfactory.nebius.com/v1", needsKey: true },
  { id: "baseten", name: "Baseten", baseURL: "https://inference.baseten.co/v1", needsKey: true },
  { id: "friendli", name: "Friendli", baseURL: "https://api.friendli.ai/serverless/v1", needsKey: true },
  { id: "upstage", name: "Upstage (Solar)", baseURL: "https://api.upstage.ai/v1/solar", needsKey: true },
  { id: "vllm", name: "vLLM (local/self-hosted)", baseURL: "http://localhost:8000/v1", needsKey: false },
  // Aggregator (like OpenRouter/SiliconFlow) with a published free-models
  // page of its own — confirmed live via its docs, not models.dev (it ships
  // its own dedicated SDK package there instead of an openai-compatible npm
  // entry, so it doesn't surface in the dynamic /connect list either).
  { id: "aihubmix", name: "AiHubMix (aggregator, incl. free models)", baseURL: "https://aihubmix.com/v1", needsKey: true },

  // Direct vendor endpoints for model families requested by name.
  { id: "nvidia", name: "NVIDIA NIM (Nemotron)", baseURL: "https://integrate.api.nvidia.com/v1", needsKey: true },
  { id: "xiaomi", name: "Xiaomi (MiMo)", baseURL: "https://api.xiaomimimo.com/v1", needsKey: true },
  { id: "meta", name: "Meta (Muse)", baseURL: "https://api.meta.ai/v1", needsKey: true },
  // OpenCode Zen: a hosted gateway (needs its own free OPENCODE_API_KEY, but
  // /models lists keyless) fronting dozens of models, several genuinely
  // $0/$0-priced ("-free" ids) — Nemotron, Ling/Ring (InclusionAI/Ant),
  // MiMo, and Muse all have a free variant here, verified live against
  // models.dev's per-model pricing, not just the provider label. This is
  // the same mechanism opencode itself uses for its free-tier defaults —
  // aerin doesn't run its own hosted gateway, so plugging into theirs is
  // the direct way to get the same "free models" experience.
  { id: "opencode", name: "OpenCode Zen (free-tier models incl. Nemotron/Ling/MiMo/Muse)", baseURL: "https://opencode.ai/zen/v1", needsKey: true },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id);
}

/** Distinctive API-key prefixes — used to catch keys pasted into the wrong provider. */
const KEY_PREFIXES: [prefix: string, provider: string][] = [
  ["sk-ant-", "anthropic"],
  ["sk-or-", "openrouter"],
  ["gsk_", "groq"],
  ["xai-", "xai"],
  ["AIza", "google"],
  ["csk-", "cerebras"],
];

/** Which provider a key's format belongs to, when the prefix is unambiguous. */
export function keyLooksLike(key: string): string | undefined {
  return KEY_PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1];
}
