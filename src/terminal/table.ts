import { wrapAnsiLine } from "./wrap-ansi.js";

/**
 * Width-aware markdown tables. marked-terminal sizes columns to their content
 * and lets the terminal wrap the result, which shears every border once a
 * table is wider than the screen. This fits the columns into `width`, word-
 * wraps cells, and draws the box itself. ANSI inside cells is zero-width.
 */

export type Align = "left" | "center" | "right" | null;
export interface TableSpec {
  header: string[];
  rows: string[][];
  align?: readonly Align[];
}
export type TableStyle = { border?: (s: string) => string; head?: (s: string) => string };

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
    let used = 0;
    for (const word of para.split(/ +/).filter(Boolean)) {
      const w = visibleWidth(word);
      if (used > 0 && used + 1 + w <= width) {
        line += ` ${word}`;
        used += 1 + w;
        continue;
      }
      if (used > 0) lines.push(line);
      const parts = w <= width ? [word] : wrapAnsiLine(word, width);
      lines.push(...parts.slice(0, -1));
      line = parts.at(-1) ?? "";
      used = visibleWidth(line);
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Column widths that fit `width` (borders and padding included): natural
 * widths when they fit, otherwise the widest columns give way first, together
 * when tied. Never below MIN_COL — narrower screens overflow, nothing to do.
 */
export function fitColumns(natural: readonly number[], width: number): number[] {
  const widths = natural.map((n) => Math.max(1, n));
  const available = width - (3 * widths.length + 1);
  const sum = () => widths.reduce((a, b) => a + b, 0);
  for (let total = sum(); total > available; total = sum()) {
    const max = Math.max(...widths);
    if (max <= MIN_COL) break;
    const widest = widths.flatMap((w, i) => (w === max ? [i] : []));
    const next = Math.max(MIN_COL, ...widths.filter((w) => w < max), max - Math.ceil((total - available) / widest.length));
    for (const i of widest) widths[i] = next;
  }
  return widths;
}

function pad(s: string, width: number, align: Align): string {
  const gap = Math.max(0, width - visibleWidth(s));
  const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
  return " ".repeat(left) + s + " ".repeat(gap - left);
}

export function renderTable(spec: TableSpec, width: number, style: TableStyle = {}): string {
  const border = style.border ?? ((s) => s);
  const head = style.head ?? ((s) => `\x1b[1m${s}\x1b[22m`);
  const cols = Math.max(spec.header.length, ...spec.rows.map((r) => r.length));
  if (cols === 0) return "";
  const cell = (row: readonly string[], i: number) => row[i] ?? "";
  const widths = fitColumns(
    Array.from({ length: cols }, (_, i) => Math.max(visibleWidth(cell(spec.header, i)), ...spec.rows.map((r) => visibleWidth(cell(r, i))))),
    width,
  );
  const rule = (l: string, m: string, r: string) => border(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const bar = border("│");
  const renderRow = (row: readonly string[], isHead: boolean): string[] => {
    const wrapped = widths.map((w, i) => wrapCell(cell(row, i), w));
    return Array.from({ length: Math.max(...wrapped.map((c) => c.length)) }, (_, y) => {
      const cells = widths.map((w, i) => {
        const text = wrapped[i]?.[y] ?? "";
        const padded = pad(text, w, isHead ? "center" : (spec.align?.[i] ?? null));
        return ` ${isHead && text ? head(padded) : padded} `;
      });
      return bar + cells.join(bar) + bar;
    });
  };
  const body = spec.rows.flatMap((row, i) => [...(i === 0 ? [] : [rule("├", "┼", "┤")]), ...renderRow(row, false)]);
  return [rule("┌", "┬", "┐"), ...renderRow(spec.header, true), ...(body.length ? [rule("├", "┼", "┤"), ...body] : []), rule("└", "┴", "┘")].join("\n");
}
