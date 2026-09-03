import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, persistProjectRule } from "../src/config/config.js";
import { providersWithKeys, PROVIDERS } from "../src/providers/registry.js";
import { truncateOutput, MAX_OUTPUT_LINES } from "../src/tools/types.js";

async function tmpCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aerin-cfg-"));
}

describe("config", () => {
  test("loads defaults when no files exist", async () => {
    const cwd = await tmpCwd();
    const { config } = await loadConfig(cwd);
    expect(config.permissions?.allow).toEqual([]);
  });

  test("project settings override and merge", async () => {
    const cwd = await tmpCwd();
    await fs.mkdir(path.join(cwd, ".aerin"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".aerin", "settings.json"),
      JSON.stringify({ model: "ollama/llama3", permissions: { allow: ["bash(git *)"] } }),
    );
    const { config } = await loadConfig(cwd);
    expect(config.model).toBe("ollama/llama3");
    expect(config.permissions?.allow).toContain("bash(git *)");
  });

  test("subagentModel parses and project overrides global", async () => {
    const cwd = await tmpCwd();
    await fs.mkdir(path.join(cwd, ".aerin"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".aerin", "settings.json"),
      JSON.stringify({ subagentModel: "anthropic/claude-haiku-4-5" }),
    );
    const { config } = await loadConfig(cwd);
    expect(config.subagentModel).toBe("anthropic/claude-haiku-4-5");
  });

  test("persistProjectRule appends without duplicates", async () => {
    const cwd = await tmpCwd();
    await persistProjectRule(cwd, "bash(npm *)");
    await persistProjectRule(cwd, "bash(npm *)");
    const { config } = await loadConfig(cwd);
    expect(config.permissions?.allow).toEqual(["bash(npm *)"]);
  });

  test("custom provider headers and protocol parse and merge from project settings", async () => {
    const cwd = await tmpCwd();
    await fs.mkdir(path.join(cwd, ".aerin"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".aerin", "settings.json"),
      JSON.stringify({
        providers: {
          mygateway: {
            baseURL: "https://gateway.example.com/v1",
            protocol: "anthropic",
            headers: { "x-tenant-id": "acme" },
          },
        },
      }),
    );
    const { config } = await loadConfig(cwd);
    expect(config.providers?.mygateway?.protocol).toBe("anthropic");
    expect(config.providers?.mygateway?.headers).toEqual({ "x-tenant-id": "acme" });
  });

  test("invalid JSON in settings raises a clear error", async () => {
    const cwd = await tmpCwd();
    await fs.mkdir(path.join(cwd, ".aerin"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".aerin", "settings.json"), "{nope");
    await expect(loadConfig(cwd)).rejects.toThrow(/Failed to parse/);
  });
});

describe("persistModelChoice", () => {
  test("sets model and maintains a deduped, capped recent list", async () => {
    const { persistModelChoice, configSchema } = await import("../src/config/config.js");
    const file = path.join(await tmpCwd(), "config.json");
    for (const id of ["a/1", "b/2", "a/1", "c/3", "d/4", "e/5", "f/6"]) {
      await persistModelChoice(id, file);
    }
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(configSchema.parse(raw).model).toBe("f/6");
    expect(raw.recentModels).toEqual(["f/6", "e/5", "d/4", "c/3", "a/1"]);
  });
});

describe("providersWithKeys", () => {
  function withoutProviderEnv<T>(fn: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const meta of Object.values(PROVIDERS)) {
      if (meta.envVar) {
        saved.set(meta.envVar, process.env[meta.envVar]);
        delete process.env[meta.envVar];
      }
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("empty when no provider has a key", () => {
    withoutProviderEnv(() => {
      expect(providersWithKeys({})).toEqual([]);
    });
  });

  test("lists exactly the providers with configured keys", () => {
    withoutProviderEnv(() => {
      expect(providersWithKeys({ providers: { openrouter: { apiKey: "sk-or-x" } } })).toEqual(["openrouter"]);
      expect(
        providersWithKeys({ providers: { openrouter: { apiKey: "x" }, openai: { apiKey: "y" } } }).sort(),
      ).toEqual(["openai", "openrouter"]);
    });
  });
});

describe("truncateOutput", () => {
  test("passes short output through", () => {
    expect(truncateOutput("hello")).toBe("hello");
  });

  test("caps line count keeping head and tail", () => {
    const total = MAX_OUTPUT_LINES + 500;
    const big = Array.from({ length: total }, (_, i) => `line${i}`).join("\n");
    const out = truncateOutput(big, { spillDir: false });
    expect(out).toContain("output truncated");
    expect(out.split("\n").length).toBeLessThan(MAX_OUTPUT_LINES + 10);
    expect(out).toContain("line0");
    expect(out).toContain(`line${total - 1}`); // tail preserved — errors live there
  });
});
