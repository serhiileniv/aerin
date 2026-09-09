import { wrapAnsiLine } from "./wrap-ansi.js";

/**
 * Width-aware markdown tables. marked-terminal sizes columns to their content
 * and lets the terminal wrap the result, which shears every border once a
 * table is wider than the screen. This fits the columns into `width`, word-
 * wraps cells, and draws the box itself. ANSI styling inside cells is kept
 * (it is zero-width for layout).
 */

export type Align = "left" | "center" | "right" | null;

export interface TableSpec {
  header: string[];
  rows: string[][];
  align?: readonly Align[];
}

export interface TableStyle {
  /** Border characters (default dim/identity). */
  border?: (s: string) => string;
  /** Header cell text (default bold). */
  head?: (s: string) => string;
}

const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const MIN_COL = 3;

export function visibleWidth(s: string): number {
  return [...s.replace(ANSI_RE, "")].length;
}

/** Word-wrap one cell to `width` visible columns; over-long words hard-wrap. */
export function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let lineWidth = 0;
    for (const word of para.split(/ +/)) {
      if (!word) continue;
      const w = visibleWidth(word);
      if (lineWidth === 0) {
        if (w <= width) {
          line = word;
          lineWidth = w;
        } else {
          const parts = wrapAnsiLine(word, width);
          lines.push(...parts.slice(0, -1));
          line = parts.at(-1) ?? "";
          lineWidth = visibleWidth(line);
        }
      } else if (lineWidth + 1 + w <= width) {
        line += ` ${word}`;
        lineWidth += 1 + w;
      } else {
        lines.push(line);
        if (w <= width) {
          line = word;
          lineWidth = w;
        } else {
          const parts = wrapAnsiLine(word, width);
          lines.push(...parts.slice(0, -1));
          line = parts.at(-1) ?? "";
          lineWidth = visibleWidth(line);
        }
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

/**
 * Column widths that fit `width` (borders and padding included): natural
 * widths when they fit, otherwise the widest columns give way first. Never
 * below MIN_COL — a screen narrower than that overflows, nothing else to do.
 */
export function fitColumns(natural: readonly number[], width: number): number[] {
  const cols = natural.length;
  const widths = natural.map((n) => Math.max(1, n));
  const available = width - (3 * cols + 1);
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > available) {
    const max = Math.max(...widths);
    if (max <= MIN_COL) break;
    const widest = widths.flatMap((w, i) => (w === max ? [i] : []));
    const runnerUp = Math.max(MIN_COL, ...widths.filter((w) => w < max));
    // Bring every widest column down together — to the next widest, or as far as needed.
    const next = Math.max(runnerUp, max - Math.ceil((total - available) / widest.length));
    for (const i of widest) widths[i] = next;
    total = widths.reduce((a, b) => a + b, 0);
  }
  return widths;
}

function pad(s: string, width: number, align: Align): string {
  const gap = width - visibleWidth(s);
  if (gap <= 0) return s;
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

export function renderTable(spec: TableSpec, width: number, style: TableStyle = {}): string {
  const border = style.border ?? ((s) => s);
  const head = style.head ?? ((s) => `\x1b[1m${s}\x1b[22m`);
  const cols = Math.max(spec.header.length, ...spec.rows.map((r) => r.length));
  if (cols === 0) return "";
  const cell = (row: readonly string[], i: number) => row[i] ?? "";
  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(visibleWidth(cell(spec.header, i)), ...spec.rows.map((r) => visibleWidth(cell(r, i)))),
  );
  const widths = fitColumns(natural, width);

  const line = (l: string, m: string, r: string) => border(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const bar = border("│");
  const renderRow = (row: readonly string[], isHead: boolean): string[] => {
    const wrapped = widths.map((w, i) => wrapCell(cell(row, i), w));
    const height = Math.max(...wrapped.map((c) => c.length));
    const out: string[] = [];
    for (let y = 0; y < height; y++) {
      const cells = widths.map((w, i) => {
        const text = wrapped[i]?.[y] ?? "";
        const padded = pad(text, w, isHead ? "center" : (spec.align?.[i] ?? null));
        return ` ${isHead && text ? head(padded) : padded} `;
      });
      out.push(bar + cells.join(bar) + bar);
    }
    return out;
  };

  const lines: string[] = [line("┌", "┬", "┐"), ...renderRow(spec.header, true)];
  if (spec.rows.length > 0) lines.push(line("├", "┼", "┤"));
  spec.rows.forEach((row, i) => {
    lines.push(...renderRow(row, false));
    if (i < spec.rows.length - 1) lines.push(line("├", "┼", "┤"));
  });
  lines.push(line("└", "┴", "┘"));
  return lines.join("\n");
}
