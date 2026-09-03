import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Checkpoints } from "../src/core/checkpoints.js";
import { discoverCommands, renderCommand } from "../src/core/commands.js";
import { resolveModel, customProviders, providersWithKeys, PROVIDERS } from "../src/providers/registry.js";
import { persistProviderKey } from "../src/config/config.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-hv-"));
}

describe("checkpoints", () => {
  test("undo restores edited and deletes created files, newest turn first", async () => {
    const cwd = await tmpCwd();
    const existing = path.join(cwd, "a.txt");
    const created = path.join(cwd, "b.txt");
    await fs.writeFile(existing, "original");

    const cp = new Checkpoints();
    cp.beginTurn();
    await cp.record(existing);
    await cp.record(created); // does not exist yet
    await fs.writeFile(existing, "modified");
    await fs.writeFile(created, "new file");

    const restored = await cp.undoLastChange();
    expect(restored.sort()).toEqual([existing, created].sort());
    expect(await fs.readFile(existing, "utf8")).toBe("original");
    await expect(fs.readFile(created, "utf8")).rejects.toThrow();
    expect(await cp.undoLastChange()).toEqual([]);
  });

  test("empty turns are skipped", async () => {
    const cwd = await tmpCwd();
    const f = path.join(cwd, "x.txt");
    await fs.writeFile(f, "v1");
    const cp = new Checkpoints();
    cp.beginTurn();
    await cp.record(f);
    await fs.writeFile(f, "v2");
    cp.beginTurn(); // turn with no changes
    cp.beginTurn(); // another
    const restored = await cp.undoLastChange();
    expect(restored).toEqual([f]);
    expect(await fs.readFile(f, "utf8")).toBe("v1");
  });
});

describe("custom commands", () => {
  test("discovers .aerin and .claude commands, substitutes $ARGUMENTS", async () => {
    const cwd = await tmpCwd();
    const mk = async (root: string, name: string, body: string): Promise<void> => {
      const d = path.join(cwd, root, "commands");
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, `${name}.md`), body);
    };
    await mk(".aerin", "review", "# Review the code\nReview $ARGUMENTS carefully.");
    await mk(".claude", "review", "claude version — should lose");
    await mk(".claude", "test-it", "Run the tests and report.");

    const commands = await discoverCommands(cwd);
    expect(commands.map((c) => c.name).sort()).toEqual(["review", "test-it"]);
    const review = commands.find((c) => c.name === "review");
    expect(review?.description).toBe("Review the code");
    expect(renderCommand(review!, "src/foo.ts")).toContain("Review src/foo.ts carefully.");
    const testIt = commands.find((c) => c.name === "test-it");
    expect(renderCommand(testIt!, "")).toBe("Run the tests and report.");
    expect(renderCommand(testIt!, "only unit")).toBe("Run the tests and report.\n\nonly unit");
  });
});

describe("custom providers", () => {
  test("baseURL entries resolve through the OpenAI-compatible adapter", () => {
    const config = { providers: { deepseek: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-x" } } };
    expect(customProviders(config)).toEqual(["deepseek"]);
    expect(providersWithKeys(config)).toContain("deepseek");
    const model = resolveModel("deepseek/deepseek-chat", config) as { modelId?: string };
    expect(model.modelId).toBe("deepseek-chat");
  });

  test("unknown provider without baseURL gives config guidance", () => {
    expect(() => resolveModel("mysterio/model-1", {})).toThrow(/baseURL/);
  });

  test("protocol: anthropic routes a custom baseURL through the Anthropic adapter, not OpenAI-compatible", () => {
    const config = {
      providers: {
        mygateway: { baseURL: "https://gateway.example.com/v1", apiKey: "sk-x", protocol: "anthropic" as const },
      },
    };
    const model = resolveModel("mygateway/claude-3-haiku", config) as { provider?: string; modelId?: string };
    expect(model.provider).toBe("anthropic.messages");
    expect(model.modelId).toBe("claude-3-haiku");
  });

  test("protocol defaults to openai-compatible when unset", () => {
    const config = { providers: { mygateway: { baseURL: "https://gateway.example.com/v1", apiKey: "sk-x" } } };
    const model = resolveModel("mygateway/some-model", config) as { provider?: string };
    expect(model.provider).toBe("mygateway.chat");
  });

  test("custom headers are accepted without throwing, for both protocols", () => {
    const openaiCfg = {
      providers: {
        mygateway: {
          baseURL: "https://gateway.example.com/v1",
          apiKey: "sk-x",
          headers: { "x-tenant-id": "acme" },
        },
      },
    };
    expect(() => resolveModel("mygateway/some-model", openaiCfg)).not.toThrow();

    const anthropicCfg = {
      providers: {
        mygateway: {
          baseURL: "https://gateway.example.com/v1",
          protocol: "anthropic" as const,
          headers: { "x-tenant-id": "acme" },
        },
      },
    };
    expect(() => resolveModel("mygateway/claude-3-haiku", anthropicCfg)).not.toThrow();
  });

  test("xai is a first-class provider", () => {
    expect(PROVIDERS["xai"]?.envVar).toBe("XAI_API_KEY");
    const model = resolveModel("xai/grok-code-fast-1", {
      providers: { xai: { apiKey: "xai-test" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("grok-code-fast-1");
  });
});

describe("provider catalog", () => {
  test("catalog entries have valid endpoints and resolve after connecting", async () => {
    const { PROVIDER_CATALOG, catalogEntry } = await import("../src/providers/catalog.js");
    for (const e of PROVIDER_CATALOG) {
      if (e.baseURL) expect(e.baseURL).toMatch(/^https?:\/\//);
    }
    const groq = catalogEntry("groq");
    expect(groq?.baseURL).toContain("api.groq.com");
    const model = resolveModel("groq/llama-3.3-70b-versatile", {
      providers: { groq: { baseURL: groq!.baseURL!, apiKey: "gsk-test" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("llama-3.3-70b-versatile");
  });

  test("catalog entry ids are unique", async () => {
    const { PROVIDER_CATALOG } = await import("../src/providers/catalog.js");
    const ids = PROVIDER_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("MiniMax's curated protocol carries through connect into resolveModel", async () => {
    const { catalogEntry } = await import("../src/providers/catalog.js");
    const minimax = catalogEntry("minimax");
    expect(minimax?.protocol).toBe("anthropic");
    const model = resolveModel("minimax/MiniMax-Text-01", {
      providers: { minimax: { baseURL: minimax!.baseURL!, apiKey: "mm-test", protocol: minimax!.protocol } },
    }) as { provider?: string; modelId?: string };
    expect(model.provider).toBe("anthropic.messages");
    expect(model.modelId).toBe("MiniMax-Text-01");
  });

  test("OpenCode Zen's free-tier ids sync to $0 pricing and resolve", async () => {
    const { catalogEntry } = await import("../src/providers/catalog.js");
    const { registerFromRegistry } = await import("../src/providers/modelsdev.js");
    const { estimateCostUsd } = await import("../src/providers/models.js");
    const opencode = catalogEntry("opencode");
    expect(opencode?.baseURL).toBe("https://opencode.ai/zen/v1");

    registerFromRegistry(
      {
        opencode: {
          models: {
            "nemotron-3-ultra-free": { cost: { input: 0, output: 0 }, limit: { context: 128000 } },
            "gpt-5.4": { cost: { input: 3, output: 15 }, limit: { context: 200000 } },
          },
        },
      },
      ["opencode"],
    );
    expect(estimateCostUsd("opencode/nemotron-3-ultra-free", 1000, 1000)).toBe(0);
    expect(estimateCostUsd("opencode/gpt-5.4", 1_000_000, 0)).toBe(3);

    const model = resolveModel("opencode/nemotron-3-ultra-free", {
      providers: { opencode: { baseURL: opencode!.baseURL!, apiKey: "oc-test" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("nemotron-3-ultra-free");
  });

  test("direct Nemotron/MiMo/Muse vendor entries resolve", async () => {
    const { catalogEntry } = await import("../src/providers/catalog.js");
    for (const [id, modelId] of [
      ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
      ["xiaomi", "mimo-v2.5"],
      ["meta", "muse-spark-1.3"],
    ] as const) {
      const entry = catalogEntry(id);
      expect(entry?.baseURL).toMatch(/^https:\/\//);
      const model = resolveModel(`${id}/${modelId}`, {
        providers: { [id]: { baseURL: entry!.baseURL!, apiKey: "test-key" } },
      }) as { modelId?: string };
      expect(model.modelId).toBe(modelId);
    }
  });

  test("aihubmix resolves", async () => {
    const { catalogEntry } = await import("../src/providers/catalog.js");
    const entry = catalogEntry("aihubmix");
    expect(entry?.baseURL).toBe("https://aihubmix.com/v1");
    const model = resolveModel("aihubmix/xiaomi-mimo-v2.5-free", {
      providers: { aihubmix: { baseURL: entry!.baseURL!, apiKey: "test-key" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("xiaomi-mimo-v2.5-free");
  });

  test("zhipuai-cn shares zai's models.dev pricing via alias, including the free flash variants", async () => {
    const { catalogEntry } = await import("../src/providers/catalog.js");
    const { registerFromRegistry } = await import("../src/providers/modelsdev.js");
    const { estimateCostUsd } = await import("../src/providers/models.js");
    const entry = catalogEntry("zhipuai-cn");
    expect(entry?.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4");

    registerFromRegistry(
      { zhipuai: { models: { "glm-4.7-flash": { cost: { input: 0, output: 0 } } } } },
      ["zhipuai-cn"],
    );
    expect(estimateCostUsd("zhipuai-cn/glm-4.7-flash", 1000, 1000)).toBe(0);

    const model = resolveModel("zhipuai-cn/glm-4.7-flash", {
      providers: { "zhipuai-cn": { baseURL: entry!.baseURL!, apiKey: "test-key" } },
    }) as { modelId?: string };
    expect(model.modelId).toBe("glm-4.7-flash");
  });
});

describe("non-chat model filtering", () => {
  async function withMockedFetch<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("google: filters out multiturn-incapable previews (computer-use, antigravity) alongside embeddings/tts/image", async () => {
    const { listProviderModels } = await import("../src/providers/list-models.js");
    const models = await withMockedFetch(
      {
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-computer-use-preview-10-2025", supportedGenerationMethods: ["generateContent"] },
          { name: "models/antigravity-preview-05-2026", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["generateContent"] },
        ],
      },
      () => listProviderModels("google", { providers: { google: { apiKey: "test-key" } } }),
    );
    expect(models?.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
  });

  test("xai: filters out image/video generation models (grok-imagine-*), keeps real chat models", async () => {
    const { listProviderModels } = await import("../src/providers/list-models.js");
    const models = await withMockedFetch(
      {
        data: [
          { id: "grok-4.6" },
          { id: "grok-code" },
          { id: "grok-imagine-image" },
          { id: "grok-imagine-video" },
          { id: "grok-imagine-image-2.0" },
        ],
      },
      () => listProviderModels("xai", { providers: { xai: { apiKey: "test-key" } } }),
    );
    expect(models?.map((m) => m.id).sort()).toEqual(["grok-4.6", "grok-code"]);
  });

  test("filter applies to a fully custom provider too, not just built-ins", async () => {
    const { listProviderModels } = await import("../src/providers/list-models.js");
    const models = await withMockedFetch(
      { data: [{ id: "big-chat-model" }, { id: "whisper-large-v3" }, { id: "text-embedding-3-small" }] },
      () => listProviderModels("mygateway", { providers: { mygateway: { baseURL: "https://gw.example/v1", apiKey: "k" } } }),
    );
    expect(models?.map((m) => m.id)).toEqual(["big-chat-model"]);
  });
});

describe("isSmallModel", () => {
  test("matches known small/fast tier keywords across providers", async () => {
    const { isSmallModel } = await import("../src/providers/list-models.js");
    expect(isSmallModel("openai/gpt-5-mini")).toBe(true);
    expect(isSmallModel("openai/gpt-5-nano")).toBe(true);
    expect(isSmallModel("anthropic/claude-haiku-4-5")).toBe(true);
    expect(isSmallModel("google/gemini-2.5-flash")).toBe(true);
    expect(isSmallModel("google/gemini-2.5-flash-lite")).toBe(true);
    expect(isSmallModel("groq/llama-3.1-8b-instant")).toBe(true);
    expect(isSmallModel("xai/grok-code-fast-1")).toBe(true);
  });

  test("does not flag large/flagship models, including MoE active-param suffixes", async () => {
    const { isSmallModel } = await import("../src/providers/list-models.js");
    expect(isSmallModel("openai/gpt-5")).toBe(false);
    expect(isSmallModel("anthropic/claude-opus-5")).toBe(false);
    expect(isSmallModel("google/gemini-3-pro")).toBe(false);
    expect(isSmallModel("nvidia/nemotron-3-ultra-550b-a55b")).toBe(false);
    expect(isSmallModel("nvidia/llama-3.1-nemotron-70b-instruct")).toBe(false);
  });
});

describe("keyLooksLike", () => {
  test("identifies distinctive key formats", async () => {
    const { keyLooksLike } = await import("../src/providers/catalog.js");
    expect(keyLooksLike("gsk_abc123")).toBe("groq");
    expect(keyLooksLike("sk-ant-api03-xyz")).toBe("anthropic");
    expect(keyLooksLike("sk-or-v1-xyz")).toBe("openrouter");
    expect(keyLooksLike("xai-abc")).toBe("xai");
    expect(keyLooksLike("sk-proj-generic")).toBeUndefined(); // ambiguous — no guess
  });
});

describe("session commands core", () => {
  test("goal / plan / mode commands drive agent and policy", async () => {
    const { goalCommand, togglePlan, cycleMode, skillsCommand, mcpCommand } = await import(
      "../src/core/session-commands.js"
    );
    const { Agent } = await import("../src/core/agent.js");
    const { PermissionPolicy } = await import("../src/permissions/policy.js");
    const { mockModel } = await import("./mock-model.js");
    const agent = new Agent({
      model: mockModel([{ text: "x" }]),
      modelId: "mock/mock",
      systemPrompt: "s",
      tools: [],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });
    const policy = new PermissionPolicy([], false);
    const ctx = {
      agent,
      policy,
      skills: [],
      mcpConnections: [],
      customCommands: [],
      sessionId: "s1",
      cwd: process.cwd(),
    };
    const armed = goalCommand(ctx, "ship it");
    expect(armed.message).toContain("ship it");
    expect(armed.run).toBe("ship it"); // frontends submit this to start the loop
    expect(agent.currentGoal).toBe("ship it");
    expect(goalCommand(ctx, "clear").message).toContain("cleared");
    expect(agent.currentGoal).toBeUndefined();
    expect(togglePlan(ctx)).toBe("plan");
    expect(togglePlan(ctx)).toBe("manual");
    expect(cycleMode(ctx)).toBe("accept");
    expect(cycleMode(ctx)).toBe("plan");
    expect(cycleMode(ctx)).toBe("manual");
    expect(skillsCommand(ctx)).toContain("No skills");
    expect(mcpCommand(ctx)).toContain("No MCP servers");
  });
});

describe("hooks", () => {
  test("hookFor resolves specific over wildcard; runHook reports exit and output", async () => {
    const { hookFor, runHook } = await import("../src/core/hooks.js");
    const hooks = { "pre:bash": "specific", "pre:*": "wild", "post:edit": "p" };
    expect(hookFor(hooks, "pre", "bash")).toBe("specific");
    expect(hookFor(hooks, "pre", "edit")).toBe("wild");
    expect(hookFor(hooks, "post", "edit")).toBe("p");
    expect(hookFor(hooks, "post", "bash")).toBeUndefined();
    expect(hookFor(undefined, "pre", "bash")).toBeUndefined();

    const ok = await runHook("echo hook-ran", "bash", { command: "x" }, process.cwd());
    expect(ok.code).toBe(0);
    expect(ok.output).toContain("hook-ran");
    const fail = await runHook("exit 3", "bash", {}, process.cwd());
    expect(fail.code).toBe(3);
  });
});

describe("models.dev capability registration", () => {
  test("tool_call:false registers even without pricing, and filters apply", async () => {
    const { registerFromRegistry } = await import("../src/providers/modelsdev.js");
    const { knownModelInfo } = await import("../src/providers/models.js");
    const count = registerFromRegistry(
      {
        testprov: {
          models: {
            "whisper-x": { tool_call: false, limit: { context: 0, output: 0 } },
            "llama-x": { tool_call: true, cost: { input: 1, output: 2 }, limit: { context: 1000, output: 100 } },
            "empty-x": {}, // nothing known — skipped
          },
        },
      },
      ["testprov"],
    );
    expect(count).toBe(2);
    expect(knownModelInfo("testprov/whisper-x")?.toolCall).toBe(false);
    expect(knownModelInfo("testprov/llama-x")?.toolCall).toBe(true);
    expect(knownModelInfo("testprov/llama-x")?.inputPerMTok).toBe(1);
    expect(knownModelInfo("testprov/empty-x")).toBeUndefined();
  });
});

describe("models.dev provider catalog", () => {
  test("parses openai-compatible and Anthropic-adapter entries with endpoints, skips the rest", async () => {
    const { parseProviderCatalog } = await import("../src/providers/modelsdev.js");
    const out = parseProviderCatalog({
      good: { npm: "@ai-sdk/openai-compatible", api: "https://api.good.ai/v1", name: "Good AI", env: "GOOD_KEY" },
      envlist: { npm: "@ai-sdk/openai-compatible", api: "https://e.ai/v1", env: ["E_KEY", "ALT"] },
      claudeish: { npm: "@ai-sdk/anthropic", api: "https://x.ai/v1", name: "Claudeish", env: "X_KEY" },
      unroutable: { npm: "@ai-sdk/cohere", api: "https://c.ai/v1" },
      noapi: { npm: "@ai-sdk/openai-compatible" },
    });
    expect(out.map((p) => p.id).sort()).toEqual(["claudeish", "envlist", "good"]);
    expect(out.find((p) => p.id === "good")?.envVar).toBe("GOOD_KEY");
    expect(out.find((p) => p.id === "envlist")?.envVar).toBe("E_KEY");
    expect(out.find((p) => p.id === "good")?.protocol).toBeUndefined();
    expect(out.find((p) => p.id === "claudeish")?.protocol).toBe("anthropic");
  });
});

describe("persistProviderKey", () => {
  test("writes and merges provider entries", async () => {
    const file = path.join(await tmpCwd(), "config.json");
    await persistProviderKey("xai", "xai-abc", undefined, undefined, file);
    await persistProviderKey("kimi", "sk-k", "https://api.moonshot.ai/v1", undefined, file);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.providers.xai.apiKey).toBe("xai-abc");
    expect(raw.providers.kimi.baseURL).toBe("https://api.moonshot.ai/v1");
  });

  test("persists a custom protocol", async () => {
    const file = path.join(await tmpCwd(), "config.json");
    await persistProviderKey("mygw", "sk-x", "https://gw.example/v1", "anthropic", file);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.providers.mygw.protocol).toBe("anthropic");
  });
});
