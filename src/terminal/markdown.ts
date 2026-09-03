import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { C, rgbOf } from "../tui/theme.js";

/**
 * Terminal markdown rendering: width-aware reflow (re-configured when the
 * terminal width changes), styled to aerin's theme palette via raw ANSI
 * (no chalk dependency), with a fallback pass for inline markdown that
 * marked-terminal leaves literal inside list items.
 */

// Match chalk's discipline: no ANSI when output isn't a color terminal.
// Colors resolve from the theme at CALL time so background detection
// (light-terminal palette swap) applies even though this module loads first.
const colorEnabled = Boolean(process.env["FORCE_COLOR"]) || process.stdout.isTTY === true;
const wrap = (get: () => string, bold = false) => (s: string) =>
  colorEnabled ? `\x1b[${bold ? "1;" : ""}38;2;${rgbOf(get())}m${s}\x1b[0m` : s;
// Exactly one hue in the whole theme (accentBright, Dark Jade) — used here
// ONLY for code keywords and diff additions. Everything else below is a
// grayscale step (fg/accent/magenta/orange/dim), so a typical reply with
// headings, prose, and a code block stays black-and-white with that one
// green touch, not a wash of color.
const brand = wrap(() => C.accentBright, true); // keywords — the one green, bold
const brandPlain = wrap(() => C.accentBright); // diff additions — the one green, plain
const boldAccent = wrap(() => C.accent, true); // headings
const accentTone = wrap(() => C.accent); // links, types/classes/functions/tags
const dim = wrap(() => C.dim); // blockquotes, hr, comments, low-emphasis
const midTone = wrap(() => C.magenta); // literals, symbols — a third gray step
const warm = wrap(() => C.orange); // inline code, numbers, strings — soft gray-white
const fg = wrap(() => C.fg);
const id = (s: string) => s;

// Syntax theme for fenced code (highlight.js token names) — grayscale except `keyword`.
const SYNTAX_THEME = {
  keyword: brand,
  built_in: fg,
  type: accentTone,
  literal: midTone,
  number: warm,
  regexp: dim,
  string: warm,
  class: accentTone,
  function: accentTone,
  title: accentTone,
  params: dim,
  comment: dim,
  doctag: dim,
  meta: dim,
  tag: accentTone,
  name: fg,
  attr: dim,
  attribute: dim,
  variable: fg,
  symbol: midTone,
  bullet: fg,
  addition: brandPlain,
  deletion: wrap(() => C.error),
  default: id,
};

let instance: Marked | undefined;
let configuredWidth = 0;

function ensure(width: number): Marked {
  if (instance && configuredWidth === width) return instance;
  configuredWidth = width;
  instance = new Marked();
  const railed = (s: string) =>
    s
      .split("\n")
      .map((l) => `${dim("│")} ${l.replace(/^ {4}/, "")}`)
      .join("\n");
  // OSC 8: clickable links in modern terminals (Windows Terminal, iTerm, ...).
  const clickable = (href: string) => `\x1b]8;;${href}\x07${accentTone(href)}\x1b]8;;\x07`;
  instance.use(
    markedTerminal({
      width,
      reflowText: true,
      showSectionPrefix: false,
      tab: 2,
      firstHeading: boldAccent,
      heading: boldAccent,
      link: accentTone,
      href: colorEnabled ? clickable : (s: string) => s,
      blockquote: dim,
      hr: dim,
      codespan: warm,
      code: railed, // fenced blocks get a dim left rail instead of bare indent
    }, colorEnabled ? { theme: SYNTAX_THEME as never } : undefined) as Parameters<Marked["use"]>[0],
  );
  return instance;
}

/** Render markdown for the terminal; falls back to raw text on any failure. */
export function renderMarkdown(text: string, width = 80): string {
  try {
    const out = ensure(Math.max(30, width)).parse(text, { async: false });
    if (typeof out !== "string") return text;
    return inlineFallback(out.trimEnd()).replace(/^(\s*)\* /gm, "$1• ");
  } catch {
    return text;
  }
}

/**
 * marked-terminal styles inline markdown in paragraphs but leaves it literal
 * inside list items — finish the job for the common cases. When the output
 * already carries ANSI styling, use ANSI; otherwise just strip the markers.
 */
function inlineFallback(text: string): string {
  const styled = text.includes("\x1b[");
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t: string) => (styled ? `\x1b[1m${t}\x1b[22m` : t))
    .replace(/__([^_\n]+)__/g, (_, t: string) => (styled ? `\x1b[1m${t}\x1b[22m` : t))
    .replace(/(?<![`\w])`([^`\n]+)`(?!`)/g, (_, t: string) => (styled ? warm(t) : t));
}
