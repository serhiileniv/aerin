/**
 * Aerin's color theme: Jade — exactly ONE green (accentBright, Dark Jade
 * #007a54) used sparingly at meaningful moments: the wordmark/banner, the
 * "●"/"✻" marks that identify aerin's own voice, diff additions, and code
 * keywords. Every other role is pure grayscale — a ramp from near-black
 * (dim) through mid-grays (magenta, accent) to near-white (fg/ok) — so the
 * app reads as black-and-white with one deliberate accent, not a wash of
 * green. `accent`, `ok`, and `magenta` keep their historical names (UI code
 * refers to roles, never raw colors) but hold neutral grays now, not hues.
 * Red and amber stay as functional signal colors for errors/warnings — the
 * one deliberate exception to "grayscale everywhere else".
 * The palette is mutable so background detection can swap in the
 * light-terminal variants before first render.
 */
export const C = {
  /** Interactive chrome: dialog borders, model name, pickers, list selection. */
  accent: "#c2c4c1", // light neutral gray — NOT green
  /** The one deliberate green: wordmark, "●"/"✻" voice marks, diff additions, code keywords. */
  accentBright: "#007a54", // Dark Jade
  /** Secondary/meta text — dark neutral gray. */
  dim: "#6e756f",
  /** Success / done / accept-mode — near-white, brightest neutral (matches fg). */
  ok: "#f3f3f1",
  /** Warnings, in-progress, queued — golden (ansiBrightYellow), kept functional. */
  warn: "#face2f",
  /** Errors and destructive hints — rust red (ansiRed), kept functional. */
  error: "#cc371e",
  /** Plan mode, section headers, reasoning — medium neutral gray, a third step, not a hue. */
  magenta: "#8a8d8a",
  /** Code accents (params, punctuation warmth) — soft warm white-gray, no green. */
  orange: "#d6d6ce",
  /** Default foreground — true near-white, no green cast. */
  fg: "#f3f3f1",
  /** Hero gradient stops (kept for brand moments): Emerald into Dark Jade into traditional pigment Emerald Green. */
  heroGradient: ["#50c878", "#007a54", "#046307"] as readonly string[],
};

/** Same roles re-picked for white/light terminal backgrounds (grayscale steps inverted: darker = more prominent on white). */
const LIGHT: typeof C = {
  accent: "#2e312e", // dark neutral gray
  accentBright: "#045c3d", // deepened Dark Jade for white — still the one green
  dim: "#55605a",
  ok: "#121212", // matches fg — brightest/most-prominent neutral on white is near-black
  warn: "#9a7b00",
  error: "#b32e14",
  magenta: "#454845", // medium neutral gray, between accent and dim
  orange: "#34342e", // dark warm-neutral ink — white itself won't show on white
  fg: "#121212", // true near-black ink, no green cast
  heroGradient: ["#2e8b57", "#045c3d", "#021f16"] as readonly string[],
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

/** "r;g;b" for raw ANSI truecolor sequences built from theme hexes. */
export function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}
