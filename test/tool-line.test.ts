import { describe, expect, test } from "bun:test";
import { fmtMs, formatToolBlock, formatToolCall, formatToolResult, resultPreview, splitSummary } from "../src/tui/tool-line.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("tool call block", () => {
  test("splits Name(args) and keeps odd summaries whole", () => {
    expect(splitSummary("Read(src/x.ts)")).toEqual({ name: "Read", args: "src/x.ts" });
    expect(splitSummary("Bash(echo (a) && ls)")).toEqual({ name: "Bash", args: "echo (a) && ls" });
    expect(splitSummary("mcp__github__list")).toEqual({ name: "mcp__github__list", args: "" });
  });

  test("call line: dot + bold name + args; dot color tracks state", () => {
    expect(strip(formatToolCall("Read(src/x.ts)", "running"))).toBe("● Read(src/x.ts)");
    expect(formatToolCall("Read(a)", "ok")).not.toBe(formatToolCall("Read(a)", "error"));
    expect(formatToolCall("Read(a)", "running")).toContain("\x1b[1m"); // bold name
  });

  test("result previews are per tool", () => {
    expect(resultPreview("Read", "1\tfoo\n2\tbar\n[10 more lines — re-run with offset=3]", 80)).toEqual({ lines: ["2 lines (+10 more)"], collapsed: true });
    expect(resultPreview("Bash", "a\nb\nc\nd\ne", 80)).toEqual({ lines: ["a", "b", "c", "… +2 lines"], collapsed: true });
    expect(resultPreview("Bash", "just one", 80)).toEqual({ lines: ["just one"], collapsed: false });
    expect(resultPreview("Glob", "a.ts\nb.ts", 80)).toEqual({ lines: ["2 files"], collapsed: true });
    expect(resultPreview("Glob", "(no matches)", 80)).toEqual({ lines: ["(no matches)"], collapsed: false });
    expect(resultPreview("Search", "x:1:foo", 80)).toEqual({ lines: ["1 match"], collapsed: true });
    expect(resultPreview("Update", "Updated x.ts (+3 -1)", 80)).toEqual({ lines: ["Updated x.ts (+3 -1)"], collapsed: false });
    expect(resultPreview("Agent", "line\nline", 80)).toEqual({ lines: ["2 lines"], collapsed: true });
    expect(resultPreview("Bash", "", 80)).toEqual({ lines: ["(no output)"], collapsed: false });
  });

  test("result line: ⎿ prefix, continuation indent, duration when slow, ctrl+o when collapsed", () => {
    expect(strip(formatToolResult("Read(x)", { output: "1\ta\n2\tb", isError: false, ms: 120 }))).toBe("  ⎿  2 lines · ctrl+o");
    expect(strip(formatToolResult("Read(x)", { output: "1\ta", isError: false, ms: 2300 }))).toBe("  ⎿  1 line · 2.3s · ctrl+o");
    expect(strip(formatToolResult("Bash(ls)", { output: "a\nb", isError: false }))).toBe("  ⎿  a\n     b");
    expect(strip(formatToolResult("Bash(x)", { output: "boom\ndetail", isError: true }))).toBe("  ⎿  ✗ boom · ctrl+o");
    expect(formatToolResult("Bash(x)", { output: "boom", isError: true })).not.toBe(formatToolResult("Bash(x)", { output: "boom", isError: false }));
  });

  test("long lines clip to the width", () => {
    const long = "x".repeat(200);
    const out = strip(formatToolResult("Bash(x)", { output: long, isError: false }, 60));
    expect(out.split("\n")[0]?.length).toBeLessThanOrEqual(60 + " · ctrl+o".length);
    expect(out).toContain("…");
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
