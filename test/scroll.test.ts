import { describe, expect, test } from "bun:test";
import {
  anchorOffset,
  buildFlatLines,
  scrollWindow,
  stepScroll,
  type FlatLine,
  type TranscriptItemLike,
} from "../src/tui/scroll.js";

/**
 * Regression net for the TUI scroll model (the v0.0.88→96 saga):
 * - the buffer must include LIVE streaming text (or output "freezes" while
 *   scrolled back),
 * - offset math must clamp, hop trailing blanks, and anchor the view while
 *   lines stream in below.
 */

const item = (key: number, kind: TranscriptItemLike["kind"], text: string): TranscriptItemLike => ({
  key,
  kind,
  text,
});

const blanks = (lines: readonly FlatLine[]): number => {
  let n = 0;
  while (n < lines.length && lines[lines.length - 1 - n]!.text === "") n++;
  return n;
};

describe("buildFlatLines", () => {
  test("one visual row per short line, blank margin row after user/assistant items", () => {
    const lines = buildFlatLines([item(1, "user", "hi"), item(2, "tool", "● bash")], "", 80);
    expect(lines.map((l) => l.text)).toEqual(["❯ hi", "", "● bash"]);
  });

  test("prefixes ❯ on the first line of a user message, indents the rest to align under it", () => {
    const lines = buildFlatLines([item(1, "user", "first\nsecond")], "", 80);
    expect(lines[0]!.text).toBe("❯ first");
    expect(lines[1]!.text).toBe("  second");
  });

  test("wraps long lines to the terminal width so one row = one scroll step", () => {
    const lines = buildFlatLines([item(1, "info", "x".repeat(100))], "", 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(38);
  });

  test("REGRESSION: live streaming text is part of the scrollable buffer", () => {
    const without = buildFlatLines([item(1, "user", "hi")], "", 80);
    const withLive = buildFlatLines([item(1, "user", "hi")], "streamed line 1\nstreamed line 2", 80);
    expect(withLive.length).toBe(without.length + 2);
    expect(withLive[withLive.length - 1]!.text).toBe("streamed line 2");
    expect(withLive[withLive.length - 1]!.key.startsWith("live:")).toBe(true);
  });

  test("streaming grows the buffer as chunks arrive (output keeps flowing)", () => {
    const a = buildFlatLines([], "line 1", 80);
    const b = buildFlatLines([], "line 1\nline 2", 80);
    expect(b.length).toBe(a.length + 1);
  });
});

describe("stepScroll", () => {
  // 10 content rows + 2 trailing blank margin rows, viewport of 5.
  const lines: FlatLine[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ key: `c${i}`, kind: "info" as const, text: `row ${i}` })),
    { key: "m1", kind: "info" as const, text: "" },
    { key: "m2", kind: "info" as const, text: "" },
  ];

  test("first upward step hops the trailing blank margin rows", () => {
    expect(blanks(lines)).toBe(2);
    expect(stepScroll(0, 1, lines, 5)).toBe(3); // 1 step + 2 blanks
  });

  test("scrolling down inside the blank margin snaps to live (0)", () => {
    expect(stepScroll(3, -1, lines, 5)).toBe(0);
  });

  test("clamps at the top — cannot scroll past the first line", () => {
    expect(stepScroll(0, 999, lines, 5)).toBe(lines.length - 5);
  });

  test("clamps at the bottom — never negative", () => {
    expect(stepScroll(1, -999, lines, 5)).toBe(0);
  });

  test("no-op on an empty transcript", () => {
    expect(stepScroll(0, 3, [], 5)).toBe(0);
  });
});

describe("anchorOffset", () => {
  test("at the bottom (offset 0) keeps following live output", () => {
    expect(anchorOffset(0, 7, 100, 10)).toBe(0);
  });

  test("REGRESSION: scrolled back, new lines below grow the offset so the view doesn't shift", () => {
    expect(anchorOffset(20, 7, 100, 10)).toBe(27);
  });

  test("clamps back into range when the transcript shrinks (/clear, /compact)", () => {
    expect(anchorOffset(80, -95, 5, 10)).toBe(0);
    expect(anchorOffset(50, 0, 40, 10)).toBe(30); // max = 40 - 10
  });
});

describe("scrollWindow", () => {
  const lines: FlatLine[] = Array.from({ length: 20 }, (_, i) => ({
    key: `c${i}`,
    kind: "info" as const,
    text: `row ${i}`,
  }));

  test("returns the viewport-sized window ending `offset` rows above the bottom", () => {
    const win = scrollWindow(lines, 5, 5);
    expect(win.map((l) => l.text)).toEqual(["row 10", "row 11", "row 12", "row 13", "row 14"]);
  });

  test("clamps at the very top", () => {
    const win = scrollWindow(lines, 999, 5);
    expect(win.map((l) => l.text)).toEqual([]);
  });

  test("window plus offset never exceeds the buffer", () => {
    const win = scrollWindow(lines, 18, 5);
    expect(win.map((l) => l.text)).toEqual(["row 0", "row 1"]);
  });
});
