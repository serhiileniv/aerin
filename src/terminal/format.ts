import type { ModelMessage } from "ai";
import { C, rgbOf } from "../tui/theme.js";

/** Concatenated text parts of a saved message (string or parts array). */
export function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type?: string; text?: string }[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|csk-[A-Za-z0-9_-]{12,})\b/g;

/** Mask API-key-shaped strings before text lands anywhere persistent. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, (m) => `${m.slice(0, 6)}…[redacted]`);
}

/** Set the terminal window/tab title (OSC 0). */
export function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${title}\x07`);
}

/** Colorize a unified diff with ANSI (theme greens/reds), 2-space indented. */
export function colorizeDiff(diff: string): string {
  const color = process.stdout.isTTY === true || Boolean(process.env["FORCE_COLOR"]);
  return diff
    .split("\n")
    .map((line) => {
      const c = `38;2;${rgbOf(line.startsWith("+") ? C.accentBright : line.startsWith("-") ? C.error : C.dim)}`;
      return color ? `  \x1b[${c}m${line}\x1b[0m` : `  ${line}`;
    })
    .join("\n");
}

/** "just now", "5m ago", "3h ago", "2d ago" — for session lists. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso.slice(0, 10);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
