import { describe, expect, test } from "bun:test";
import { fitColumns, renderTable, visibleWidth, wrapCell } from "../src/terminal/table.js";

describe("fitColumns", () => {
  test("keeps natural widths when they fit", () => {
    expect(fitColumns([5, 10, 7], 80)).toEqual([5, 10, 7]);
  });

  test("shrinks the widest columns first until the table fits", () => {
    const widths = fitColumns([15, 100, 40], 60);
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(60 - (3 * 3 + 1));
    expect(widths[0]).toBe(15); // the narrow column is untouched
    expect(Math.abs((widths[1] ?? 0) - (widths[2] ?? 0))).toBeLessThanOrEqual(1); // tied columns give way together
  });

  test("never goes below the minimum, even on absurd widths", () => {
    expect(fitColumns([50, 50, 50], 10)).toEqual([3, 3, 3]);
  });
});

describe("wrapCell", () => {
  test("wraps on words, hard-wraps words longer than the column, keeps ANSI zero-width", () => {
    expect(wrapCell("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapCell("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapCell("\x1b[1mbold\x1b[22m word", 6)).toEqual(["\x1b[1mbold\x1b[22m", "word"]);
    expect(visibleWidth("\x1b[38;2;1;2;3mabc\x1b[0m")).toBe(3);
    expect(wrapCell("", 5)).toEqual([""]);
  });
});

describe("renderTable", () => {
  test("draws a box whose every line is at most the width, with wrapped cells and alignment", () => {
    const out = renderTable(
      { header: ["Name", "Description", "N"], rows: [["alpha", "a fairly long description that must wrap onto several lines", "1"], ["b", "short", "22"]], align: [null, null, "right"] },
      40,
      { head: (s) => s },
    );
    const lines = out.split("\n");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    expect(lines[0]?.startsWith("┌")).toBe(true);
    expect(lines.at(-1)?.startsWith("└")).toBe(true);
    expect(lines.filter((l) => l.startsWith("├")).length).toBe(2); // header/body + between rows
    expect(lines.some((l) => l.includes("│  1 │"))).toBe(true); // right-aligned in a 2-wide column
    expect(lines.some((l) => l.includes("│ 22 │"))).toBe(true);
  });

  test("an empty table renders nothing", () => {
    expect(renderTable({ header: [], rows: [] }, 40)).toBe("");
  });
});
