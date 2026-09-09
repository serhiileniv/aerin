import { describe, expect, test } from "bun:test";
import { child, fmtMs, formatToolBlock, formatToolCall, formatToolResult, resultPreview, splitSummary } from "../src/tui/tool-line.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("tool call block", () => {
  test("splits Name(args) and keeps odd summaries whole", () => {
    expect(splitSummary("Read(src/x.ts)")).toEqual({ name: "Read", args: "src/x.ts" });
    expect(splitSummary("Bash(echo (a) && ls)")).toEqual({ name: "Bash", args: "echo (a) && ls" });
    expect(splitSummary("Mcp(github.list)")).toEqual({ name: "Mcp", args: "github.list" });
  });

  test("call line: dot + bold name + args; dot color tracks state; long lines hang under the name", () => {
    expect(strip(formatToolCall("Read(src/x.ts)", "running"))).toBe("● Read(src/x.ts)");
    expect(formatToolCall("Read(a)", "ok")).not.toBe(formatToolCall("Read(a)", "error"));
    expect(formatToolCall("Read(a)", "running")).toContain("\x1b[1m");
    const wrapped = strip(formatToolCall(`Bash(${"x".repeat(100)})`, "ok", 40)).split("\n");
    expect(wrapped.length).toBeGreaterThan(1);
    for (const l of wrapped) expect(l.length).toBeLessThanOrEqual(42);
    expect(wrapped[1]?.startsWith("  ")).toBe(true);
  });

  test("result previews are per tool", () => {
    expect(resultPreview("Read", "1\tfoo\n2\tbar\n[10 more lines — re-run with offset=3]", 80)).toEqual({ lines: ["2 lines (+10 more)"], collapsed: true });
    expect(resultPreview("Bash", "a\nb\nc\nd\ne", 80)).toEqual({ lines: ["a", "b", "c", "… +2 lines"], collapsed: true });
    expect(resultPreview("Bash", "just one", 80)).toEqual({ lines: ["just one"], collapsed: false });
    expect(resultPreview("Glob", "a.ts\nb.ts", 80)).toEqual({ lines: ["2 files"], collapsed: true });
    expect(resultPreview("Glob", "(no matches)", 80)).toEqual({ lines: ["(no matches)"], collapsed: false });
    expect(resultPreview("Search", "x:1:foo", 80)).toEqual({ lines: ["1 match"], collapsed: true });
    expect(resultPreview("Update", "Updated x.ts (+3 -1)", 80)).toEqual({ lines: ["Updated x.ts (+3 -1)"], collapsed: false });
    expect(resultPreview("Bash", "", 80)).toEqual({ lines: ["(no output)"], collapsed: false });
  });

  test("result line: ⎿ prefix, continuation indent, duration when slow, ctrl+o only when asked", () => {
    const r = (s: string, o: Parameters<typeof formatToolResult>[1], w?: number, hint?: boolean) => strip(formatToolResult(s, o, w, hint).text);
    expect(r("Read(x)", { output: "1\ta\n2\tb", isError: false, ms: 120 })).toBe("  ⎿  2 lines · ctrl+o");
    expect(r("Read(x)", { output: "1\ta", isError: false, ms: 2300 })).toBe("  ⎿  1 line · 2.3s · ctrl+o");
    expect(r("Read(x)", { output: "1\ta", isError: false, ms: 2300 }, 100, false)).toBe("  ⎿  1 line · 2.3s");
    expect(formatToolResult("Read(x)", { output: "1\ta", isError: false }).collapsed).toBe(true);
    expect(r("Bash(ls)", { output: "a\nb", isError: false })).toBe("  ⎿  a\n     b");
    expect(r("Bash(x)", { output: "boom\ndetail", isError: true })).toBe("  ⎿  ✗ boom · ctrl+o");
  });

  test("no result line ever exceeds the width, meta suffix included", () => {
    for (const width of [40, 60, 80]) {
      const out = strip(formatToolBlock(`Bash(${"y".repeat(50)})`, { output: `${"x".repeat(200)}\nshort\n${"z".repeat(90)}\nmore\nmore`, isError: false, ms: 4200 }, width));
      for (const l of out.split("\n")) expect([...l].length).toBeLessThanOrEqual(width);
      expect(out).toContain("4.2s");
    }
  });

  test("child() hangs any text under a block", () => {
    expect(strip(child("done · 42s"))).toBe("  ⎿  done · 42s");
    expect(strip(child("a\nb"))).toBe("  ⎿  a\n     b");
  });

  test("block: running is one line, finished is call + result", () => {
    expect(strip(formatToolBlock("Read(x)")).split("\n")).toHaveLength(1);
    expect(strip(formatToolBlock("Read(x)", { output: "1\ta", isError: false }))).toBe("● Read(x)\n  ⎿  1 line · ctrl+o");
  });

  test("fmtMs", () => {
    expect(fmtMs(300)).toBe("300ms");
    expect(fmtMs(2340)).toBe("2.3s");
    expect(fmtMs(12_400)).toBe("12s");
    expect(fmtMs(75_000)).toBe("1m 15s");
  });
});
