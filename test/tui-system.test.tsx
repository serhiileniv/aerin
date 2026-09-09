import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { DiffText, SelectList, diffBody } from "../src/tui/components/widgets.js";
import { Agent } from "../src/core/agent.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { bashTool } from "../src/tools/bash.js";
import { mockModel } from "./mock-model.js";

/** docs/specs/tui-polish.md acceptance criteria that are about the source itself. */
const tuiSources = () =>
  ["src/tui", "src/modes", "src/terminal"].flatMap((d) =>
    fs.readdirSync(d, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(d, f)),
  );

describe("one visual system", () => {
  test("retired glyphs are gone from every frontend", () => {
    const banned = /└|»|✻|✦|↻|✎|\[x\]|\[>\]|"[^"\n]*>>/; // `>>` only inside a string literal (bit shifts are fine)
    for (const f of tuiSources()) {
      if (f.endsWith("table.ts")) continue; // box drawing for markdown tables is a different alphabet
      const hits = fs.readFileSync(f, "utf8").split("\n").filter((l) => banned.test(l));
      expect({ file: f, hits }).toEqual({ file: f, hits: [] });
    }
  });

  test("no hardcoded black and no dimColor on truecolor text (light-theme safety)", () => {
    for (const f of tuiSources()) {
      const src = fs.readFileSync(f, "utf8");
      expect({ file: f, black: src.includes("#000000"), dimColor: src.includes("dimColor") }).toEqual({ file: f, black: false, dimColor: false });
    }
  });

  test("permission previews drop patch headers and say how much was cut", () => {
    const patch = "Index: a.ts\n===================================================================\n--- a.ts\tbefore\n+++ a.ts\tafter\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n";
    expect(diffBody(patch)).toEqual(["@@ -1,2 +1,2 @@", "-old", "+new", " context", ""]);
    const out = new PassThrough();
    let text = "";
    out.on("data", (c: Buffer) => (text += c.toString()));
    const app = render(<DiffText diff={patch} maxLines={2} />, { stdout: out as unknown as NodeJS.WriteStream, debug: true });
    app.unmount();
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).not.toContain("Index:");
    expect(plain).toContain("… +3 lines");
  });

  test("Esc inside a select list cancels the list, never the turn; number keys pick", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
    const out = new PassThrough();
    out.on("data", () => {});
    const picked: string[] = [];
    let cancelled = 0;
    const app = render(
      <SelectList active items={[{ label: "Yes", value: "allow" }, { label: "No", value: "deny" }]} onSelect={(v) => picked.push(v)} onCancel={() => cancelled++} />,
      { stdin: stdin as unknown as NodeJS.ReadStream, stdout: out as unknown as NodeJS.WriteStream, debug: true },
    );
    const tick = () => new Promise((r) => setTimeout(r, 30));
    await tick();
    stdin.write("\x1b");
    await tick();
    stdin.write("2");
    await tick();
    app.unmount();
    expect(cancelled).toBe(1);
    expect(picked).toEqual(["deny"]);
  });

  test("a replayed tool call renders with the same Name(args) as the live one", () => {
    const agent = new Agent({
      model: mockModel([]),
      modelId: "mock/m",
      systemPrompt: "t",
      tools: [bashTool],
      policy: new PermissionPolicy([], false),
      onPermission: async () => ({ kind: "allow" }),
      cwd: process.cwd(),
      allowOutsideCwd: false,
    });
    expect(agent.summarizeCall("bash", { command: "ls -la" })).toBe("Bash(ls -la)");
    expect(agent.summarizeCall("nope", {})).toBe("nope");
  });
});
