import { C, paint } from "./theme.js";
import { wrapAnsiLine } from "../terminal/wrap-ansi.js";

/**
 * Transcript blocks (docs/specs/tui-polish.md). A tool call is one block,
 * rewritten in place when the result lands:
 *
 *   ● Read(src/tui/App.tsx)          dot: dim while running, green ok, red error
 *     ⎿  1,240 lines · 1.3s · ctrl+o  stat, duration when ≥1s, ctrl+o once per turn
 *
 * `⎿` is the one "belongs to the block above" glyph — tool results, diffs,
 * receipts, sub-agent lines all use `child()`. Bash shows its first lines
 * because that IS the result; file/search tools show counts. No line ever
 * exceeds `width`. Pure strings with ANSI baked in, so the live path and the
 * scroll-back window render identically.
 */

export type ToolState = "running" | "ok" | "error";
export interface ToolResultInfo {
  output: string;
  isError: boolean;
  /** Wall time of the call, shown when it took a second or more. */
  ms?: number;
}

export const PREFIX = "  ⎿  ";
export const INDENT = "     ";
const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);
const count = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;

/** "Read(src/x.ts)" → { name: "Read", args: "src/x.ts" }; anything else is all name. */
export function splitSummary(summary: string): { name: string; args: string } {
  const m = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(summary.trim());
  return m ? { name: m[1] ?? summary, args: m[2] ?? "" } : { name: summary.trim(), args: "" };
}

/** A dim line hanging under a block: `  ⎿  text`, continuation lines indented to the text. */
export function child(text: string, color = C.dim): string {
  return text.split("\n").map((l, i) => paint((i === 0 ? PREFIX : INDENT) + l, color)).join("\n");
}

/** `● Name(args)`; when `width` is given, wrapped continuation lines hang under the name. */
export function formatToolCall(summary: string, state: ToolState, width?: number): string {
  const { name, args } = splitSummary(summary);
  const dot = paint("●", state === "running" ? C.dim : state === "ok" ? C.accentBright : C.error);
  const line = `${dot} ${paint(name, C.fg, true)}${args ? paint("(", C.dim) + paint(args, C.accent) + paint(")", C.dim) : ""}`;
  if (!width) return line;
  return wrapAnsiLine(line, width).map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The one-glance stat for a successful result, by tool: lines to show and whether more is hidden. */
export function resultPreview(name: string, output: string, width: number): { lines: string[]; collapsed: boolean } {
  const trimmed = output.trim();
  if (!trimmed) return { lines: ["(no output)"], collapsed: false };
  const all = trimmed.split("\n");
  const more = /^\[(\d+) more (lines|matches)[^\]]*\]$/.exec(all.at(-1) ?? "");
  const body = more ? all.slice(0, -1) : all;
  const extra = more ? ` (+${Number(more[1]).toLocaleString("en-US")} more)` : "";
  const counted = (noun: string) => ({ lines: [`${count(body.length, noun)}${extra}`], collapsed: true });
  if (name === "Bash" || name === "JobOutput") {
    const lines = body.slice(0, 3).map((l) => clip(l, width));
    const rest = body.length - lines.length;
    if (rest > 0) lines.push(`… +${count(rest, "line")}`);
    return { lines, collapsed: rest > 0 || body.some((l) => l.length > width) };
  }
  if (name === "Read") return counted("line");
  if (/^(Glob|List|Search)$/.test(name)) {
    return trimmed.startsWith("(") ? { lines: [trimmed], collapsed: false } : counted(name === "Glob" ? "file" : name === "List" ? "entry" : "match");
  }
  return body.length === 1 && body[0]!.length <= width ? { lines: [body[0]!], collapsed: false } : counted("line");
}

/** The `⎿` line(s) under a call. `hint` adds ` · ctrl+o` when output is collapsed (once per turn is enough). */
export function formatToolResult(summary: string, result: ToolResultInfo, width = 100, hint = true): { text: string; collapsed: boolean } {
  const inner = Math.max(20, width - PREFIX.length);
  let preview: { lines: string[]; collapsed: boolean };
  if (result.isError) {
    const all = result.output.trim().split("\n");
    preview = { lines: [`✗ ${clip(all[0] ?? "error", inner - 2)}`], collapsed: all.length > 1 || (all[0] ?? "").length > inner - 2 };
  } else preview = resultPreview(splitSummary(summary).name, result.output, inner);
  const meta = [...(result.ms !== undefined && result.ms >= 1000 ? [fmtMs(result.ms)] : []), ...(hint && preview.collapsed ? ["ctrl+o"] : [])];
  const suffix = meta.length ? ` · ${meta.join(" · ")}` : "";
  const lines = preview.lines.map((l, i) => (i === preview.lines.length - 1 ? clip(l, inner - suffix.length) + suffix : clip(l, inner)));
  return { text: child(lines.join("\n"), result.isError ? C.error : C.dim), collapsed: preview.collapsed };
}

/** Call line plus, once known, its result line — the whole transcript block. */
export function formatToolBlock(summary: string, result?: ToolResultInfo, width?: number, hint = true): string {
  if (!result) return formatToolCall(summary, "running", width);
  return `${formatToolCall(summary, result.isError ? "error" : "ok", width)}\n${formatToolResult(summary, result, width, hint).text}`;
}
