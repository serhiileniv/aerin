import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, PermissionRequest } from "../src/core/events.js";
import { createAgentTool, subagentTools, workerTools } from "../src/tools/agent-tool.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { discoverAgents } from "../src/core/agents.js";
import { mockModel } from "./mock-model.js";

describe("subagentTools", () => {
  test("is exactly the read-only set — no agent (recursion guard), no write/edit/bash", () => {
    const names = subagentTools().map((t) => t.name).sort();
    expect(names).toEqual(["glob", "grep", "ls", "read", "webfetch", "websearch"]);
  });

  test("every sub-agent tool is read-tier", () => {
    for (const t of subagentTools()) expect(t.permission).toBe("read");
  });
});

describe("workerTools", () => {
  test("adds write/edit/bash to the research set but still no agent tool", () => {
    const names = workerTools().map((t) => t.name).sort();
    expect(names).toEqual(["bash", "edit", "glob", "grep", "ls", "read", "webfetch", "websearch", "write"]);
  });
});

describe("agent tool", () => {
  const deps = { getModel: () => ({ model: mockModel([{ text: "unused" }]), modelId: "mock/mock" }) };

  test("is read-tier and validates its flat schema", () => {
    const tool = createAgentTool(deps);
    expect(tool.permission).toBe("read");
    expect(tool.inputSchema.safeParse({ description: "x", prompt: "y" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ description: "x" }).success).toBe(false);
    expect(tool.summarize({ description: "find stuff", prompt: "y" })).toBe("Agent(find stuff)");
  });

  test("runs a sub-agent and returns its report, emitting one final update", async () => {
    const tool = createAgentTool({
      getModel: () => ({
        model: mockModel([{ text: "REPORT", usage: { inputTokens: 100, outputTokens: 20 } }]),
        modelId: "mock/mock",
      }),
    });
    const events: AgentEvent[] = [];
    const output = await tool.execute(
      { description: "test task", prompt: "go" },
      { cwd: process.cwd(), allowOutsideCwd: false, onProgress: (e) => events.push(e), toolCallId: "tc1" },
    );
    expect(output).toBe("REPORT");
    const finals = events.filter((e) => e.type === "subagent-update" && e.status !== "running");
    expect(finals).toHaveLength(1);
    const final = finals[0] as Extract<AgentEvent, { type: "subagent-update" }>;
    expect(final.id).toBe("tc1");
    expect(final.status).toBe("done");
    expect(final.description).toBe("test task");
    expect(final.inputTokens).toBe(100);
    expect(final.outputTokens).toBe(20);
  });

  test("uses the subagent model override when provided", async () => {
    let overrideUsed = false;
    const tool = createAgentTool({
      getModel: () => ({ model: mockModel([{ text: "main" }]), modelId: "mock/main" }),
      getSubagentModel: () => {
        overrideUsed = true;
        return { model: mockModel([{ text: "cheap" }]), modelId: "mock/cheap" };
      },
    });
    const output = await tool.execute(
      { description: "x", prompt: "y" },
      { cwd: process.cwd(), allowOutsideCwd: false },
    );
    expect(overrideUsed).toBe(true);
    expect(output).toBe("cheap");
  });

  test("worker mode writes files through the parent's permission gate, with a labeled ask", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-worker-"));
    const asks: PermissionRequest[] = [];
    const tool = createAgentTool({
      getModel: () => ({
        model: mockModel([
          { toolCalls: [{ toolCallId: "w1", toolName: "write", input: { path: "out.txt", content: "hello" } }] },
          { text: "WORKER REPORT" },
        ]),
        modelId: "mock/mock",
      }),
      policy: new PermissionPolicy([], false),
      onPermission: async (req) => {
        asks.push(req);
        return { kind: "allow" };
      },
      getShadow: async () => null, // tests must not touch the real shadow data dir
    });

    const output = await tool.execute(
      { description: "write greeting", prompt: "create out.txt", mode: "worker" },
      { cwd, allowOutsideCwd: false },
    );
    expect(output).toBe("WORKER REPORT");
    expect(await fs.readFile(path.join(cwd, "out.txt"), "utf8")).toBe("hello");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.summary).toContain("Agent(write greeting) ›");
  });

  test("worker mode respects a user denial and reports instead of writing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-worker-"));
    const tool = createAgentTool({
      getModel: () => ({
        model: mockModel([
          { toolCalls: [{ toolCallId: "w1", toolName: "write", input: { path: "out.txt", content: "hello" } }] },
          { text: "BLOCKED REPORT" },
        ]),
        modelId: "mock/mock",
      }),
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "deny", reason: "not this file" }),
      getShadow: async () => null,
    });

    const output = await tool.execute(
      { description: "write greeting", prompt: "create out.txt", mode: "worker" },
      { cwd, allowOutsideCwd: false },
    );
    expect(output).toBe("BLOCKED REPORT");
    expect(fs.access(path.join(cwd, "out.txt"))).rejects.toThrow();
  });

  test("research mode has no write tool even if the model tries to call it", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-worker-"));
    const tool = createAgentTool({
      getModel: () => ({
        model: mockModel([
          { toolCalls: [{ toolCallId: "w1", toolName: "write", input: { path: "out.txt", content: "x" } }] },
          { text: "RESEARCH REPORT" },
        ]),
        modelId: "mock/mock",
      }),
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      getShadow: async () => null,
    });

    const output = await tool.execute(
      { description: "just research", prompt: "look around" },
      { cwd, allowOutsideCwd: false },
    );
    expect(output).toBe("RESEARCH REPORT");
    expect(fs.access(path.join(cwd, "out.txt"))).rejects.toThrow(); // unknown tool, nothing written
  });

  test("named agents opt into worker mode via frontmatter", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aerin-agents-"));
    await fs.mkdir(path.join(cwd, ".aerin", "agents"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".aerin", "agents", "fixer.md"),
      "---\nname: fixer\ndescription: fixes things\nmode: worker\n---\nYou fix things.\n",
    );
    await fs.writeFile(
      path.join(cwd, ".aerin", "agents", "scout.md"),
      "---\nname: scout\ndescription: reads things\n---\nYou read things.\n",
    );
    const agents = await discoverAgents(cwd);
    expect(agents.find((a) => a.name === "fixer")?.mode).toBe("worker");
    expect(agents.find((a) => a.name === "scout")?.mode).toBeUndefined();
  });

  test("throws when the sub-agent errors without producing a report", async () => {
    const broken = {
      getModel: () => ({
        model: (() => {
          const m = mockModel([{ text: "x" }]) as unknown as { doStream: () => Promise<never> };
          m.doStream = async () => {
            throw new Error("provider exploded");
          };
          return m as unknown as ReturnType<typeof mockModel>;
        })(),
        modelId: "mock/mock",
      }),
    };
    const tool = createAgentTool(broken);
    await expect(
      tool.execute({ description: "x", prompt: "y" }, { cwd: process.cwd(), allowOutsideCwd: false }),
    ).rejects.toThrow(/Sub-agent failed/);
  });
});
