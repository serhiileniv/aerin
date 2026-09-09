/**
 * Aerin's color theme: Jade — exactly ONE green (accentBright, Dark Jade
 * #007a54) that means *status*: the wordmark, a tool call that succeeded,
 * diff additions, ✓ outcomes, code keywords. The assistant's own "●" is fg,
 * so a reply and a finished tool never look alike. Every other role is pure grayscale — five distinct steps from
 * near-black (dim) up through magenta, ok, and accent to near-white (fg) —
 * so the app reads as black-and-white with one deliberate accent, not a
 * wash of green. `accent`, `ok`, and `magenta` keep their historical names
 * (UI code refers to roles, never raw colors) but hold neutral grays now,
 * not hues. Each step must stay visually distinct from its neighbors —
 * plan mode (magenta) and accept mode (ok) are both real states the input
 * border signals, and easy to confuse if they're too close in lightness.
 * Red stays as the functional signal color for errors — the one deliberate
 * exception to "grayscale everywhere else". There is no amber/yellow: a
 * working/in-progress state uses the one accent green instead.
 * The palette is mutable so background detection can swap in the
 * light-terminal variants before first render.
 */
export const C = {
  /** Interactive chrome: dialog borders, model name, pickers, list selection. */
  accent: "#c2c4c1", // light neutral gray — NOT green
  /** The one deliberate green — status only: wordmark, tool-ok "●", diff additions, ✓, code keywords. */
  accentBright: "#007a54", // Dark Jade
  /** Secondary/meta text — dark neutral gray. */
  dim: "#6e756f",
  /** Success / done / accept-mode — a distinct step between magenta and accent, not fg. */
  ok: "#a5a8a5",
  /** Errors and destructive hints — rust red (ansiRed), kept functional. */
  error: "#cc371e",
  /** Plan mode, section headers, reasoning — medium neutral gray, a third step, not a hue. */
  magenta: "#8a8d8a",
  /** Code accents (params, punctuation warmth) — soft warm white-gray, no green. */
  orange: "#d6d6ce",
  /** Default foreground — true near-white, no green cast. */
  fg: "#f3f3f1",
};

/** Same roles re-picked for white/light terminal backgrounds (grayscale steps inverted: darker = more prominent on white). */
const LIGHT: typeof C = {
  accent: "#2e312e", // dark neutral gray
  accentBright: "#045c3d", // deepened Dark Jade for white — still the one green
  dim: "#55605a",
  ok: "#393c39", // distinct step between accent and magenta, not fg
  error: "#b32e14",
  magenta: "#454845", // medium neutral gray, between accent and dim
  orange: "#34342e", // dark warm-neutral ink — white itself won't show on white
  fg: "#121212", // true near-black ink, no green cast
};

let lightMode = false;

/** Swap the palette for a light terminal background. Call before first render. */
export function applyBackgroundTheme(light: boolean): void {
  lightMode = light;
  if (light) Object.assign(C, LIGHT);
}

/** Whether the light-background palette is active. */
export function isLightTheme(): boolean {
  return lightMode;
}

/** Truecolor ANSI paint for text baked into the transcript. */
export function paint(s: string, hex: string, bold = false): string {
  return `${bold ? "\x1b[1m" : ""}\x1b[38;2;${rgbOf(hex)}m${s}\x1b[0m`;
}

/** "r;g;b" for raw ANSI truecolor sequences built from theme hexes. */
export function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}
