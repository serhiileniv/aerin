import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/terminal/markdown.js";

describe("renderMarkdown", () => {
  test("renders markdown bold", () => {
    expect(renderMarkdown("**bold**")).toBe("bold");
  });

  test("renders markdown header", () => {
    expect(renderMarkdown("# header")).toBe("header");
  });

  test("renders markdown list", () => {
    expect(renderMarkdown("- item 1\n- item 2")).toContain("item 1");
    expect(renderMarkdown("- item 1\n- item 2")).toContain("item 2");
  });

  test("renders inline markdown inside list items (marked-terminal gap)", () => {
    const out = renderMarkdown("* **83/83 tests** passed\n* `code` too");
    expect(out).not.toContain("**");
    expect(out).toContain("83/83 tests");
    expect(out).not.toContain("`code`");
    expect(out).toContain("code too");
  });

  test("tables fit the given width instead of overflowing and shearing", () => {
    const md = [
      "| Use case | Why | Hardware |",
      "|---|---|---|",
      "| Chat assistants | Handles multi-turn dialogs with good depth; 20B-level context is enough for most business chatbots. | 1-2 RTX 3090 (24 GB) or 8-GB A100 for inference. |",
      "| Code completion | 20B models language well, gives accurate syntax and context-aware code suggestions. | Single RTX 4090. |",
    ].join("\n");
    const out = renderMarkdown(md, 60);
    const lines = out.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(6);
    for (const l of lines) expect([...l.replace(/\x1b\[[0-9;]*m/g, "")].length).toBeLessThanOrEqual(60);
    expect(lines[0]).toMatch(/^┌─+┬─+┬─+┐$/);
    expect(lines.at(-1)).toMatch(/^└─+┴─+┴─+┘$/);
    expect(out.replace(/\s+/g, " ")).toContain("Chat assistants");
    expect(out).toContain("Single RTX 4090.");
  });

  test("a table that already fits keeps its natural column widths", () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 80);
    expect(out.split("\n")[0]).toBe("┌───┬───┐");
  });

  test("falls back to raw text if error occurs", () => {
    const broken = "\[unclosed\[";
    expect(renderMarkdown(broken)).toBe(broken);
  });
});