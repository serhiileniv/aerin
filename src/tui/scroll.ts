import { wrapAnsiLine } from "../terminal/wrap-ansi.js";

/**
 * Pure scroll model for the fullscreen TUI (extracted from App.tsx so
 * regressions are unit-testable): the transcript is pre-wrapped into VISUAL
 * rows — the unit of scrolling — and offset math is done here.
 */

export type TranscriptKind = "user" | "assistant" | "tool" | "tool-error" | "info" | "error";

export interface TranscriptItemLike {
  key: number;
  kind: TranscriptKind;
  text: string;
}

export interface FlatLine {
  key: string;
  kind: TranscriptKind;
  text: string;
}

/** "❯ " on the first line, aligned indent on the rest — mirrors the assistant's "●" convention. */
export function prefixUserLines(text: string): string {
  const lines = text.split("\n");
  return [`❯ ${lines[0] ?? ""}`, ...lines.slice(1).map((l) => `  ${l}`)].join("\n");
}

/**
 * Flatten the transcript into visual rows: long lines are pre-wrapped
 * (ANSI-aware) so one scroll step is one terminal row, blank rows reproduce
 * the item margins, and the LIVE streaming text is included at the end so
 * output keeps flowing (and stays reachable) while scrolled back.
 */
export function buildFlatLines(
  items: readonly TranscriptItemLike[],
  streaming: string,
  columns: number,
): FlatLine[] {
  const width = Math.max(20, columns - 2);
  const lines: FlatLine[] = [];
  for (const item of items) {
    const text = item.kind === "user" ? prefixUserLines(item.text) : item.text;
    text.split("\n").forEach((line, i) => {
      wrapAnsiLine(line, width).forEach((row, j) => {
        lines.push({ key: `${item.key}:${i}:${j}`, kind: item.kind, text: row });
      });
    });
    if (item.kind === "assistant" || item.kind === "user") {
      lines.push({ key: `${item.key}:m`, kind: "info", text: "" });
    }
  }
  if (streaming) {
    streaming.split("\n").forEach((line, i) => {
      wrapAnsiLine(line, width).forEach((row, j) => {
        lines.push({ key: `live:${i}:${j}`, kind: "assistant", text: row });
      });
    });
  }
  return lines;
}

/**
 * New offset after a wheel/page step (positive = scroll back). The first
 * upward step hops the trailing blank margin rows (otherwise a wheel notch
 * "scrolls" only blanks and looks dead), and scrolling back down inside them
 * snaps to live. Clamped to [0, max].
 */
export function stepScroll(
  current: number,
  deltaLines: number,
  lines: readonly FlatLine[],
  viewportH: number,
): number {
  const max = Math.max(0, lines.length - Math.max(4, viewportH));
  let blanks = 0;
  while (blanks < lines.length && lines[lines.length - 1 - blanks]!.text === "") blanks++;
  let next = current + deltaLines;
  if (current === 0 && deltaLines > 0) next += blanks;
  else if (deltaLines < 0 && next <= blanks) next = 0;
  return Math.min(max, Math.max(0, next));
}

/**
 * Offset adjustment when the line count changes by `delta`: at the bottom
 * (offset 0) keep following live output; scrolled back, grow the offset by
 * the same amount so the text on screen doesn't shift; shrinking transcripts
 * (/clear, /compact) clamp back into range.
 */
export function anchorOffset(current: number, delta: number, lineCount: number, viewportH: number): number {
  if (current === 0) return 0;
  const max = Math.max(0, lineCount - Math.max(4, viewportH));
  return Math.min(max, Math.max(0, current + delta));
}

/** The visible window of rows for a given scroll offset. */
export function scrollWindow(lines: readonly FlatLine[], offset: number, viewportH: number): FlatLine[] {
  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - viewportH);
  return lines.slice(start, end);
}
