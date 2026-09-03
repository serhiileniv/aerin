/**
 * Aerin's color theme: Jade — a tight, technical palette on a black ground:
 * emerald/jade hero #00c078, cooler mint-jade interactive voice, pale jade for
 * secondary emphasis, off-white foreground. Red and amber stay as functional
 * signal colors for errors/warnings — the one deliberate exception to the
 * green/black/white palette, kept for scannability.
 * Central palette: UI code refers to roles, never raw colors, so retheming is
 * a one-file change. The palette is mutable so background detection can swap
 * in the light-terminal variants before first render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#4fd6a0", // mint-jade — cooler and lighter than the hero
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#00c078", // vivid emerald/jade — the theme's signature pop
  /** Secondary/meta text — stone gray with the jade ground's undertone. */
  dim: "#5c7568",
  /** Success / done — clear leaf green, distinct from the hero's blue-green. */
  ok: "#2ed573",
  /** Warnings, in-progress, queued — golden (ansiBrightYellow), kept functional. */
  warn: "#face2f",
  /** Errors and destructive hints — rust red (ansiRed), kept functional. */
  error: "#cc371e",
  /** Plan mode, section headers, reasoning — pale jade, the palette's lightest tint. */
  magenta: "#8feac3",
  /** Code accents (params, punctuation warmth) — soft off-white, the palette's "warm" note. */
  orange: "#edede6",
  /** Default foreground — near-white with a faint mint cast. */
  fg: "#e7efea",
  /** Hero gradient stops (kept for brand moments): bright mint melting into near-black jade. */
  heroGradient: ["#5fe8b0", "#00c078", "#0a3d2a"] as readonly string[],
};

/** Same roles re-picked for white/light terminal backgrounds. */
const LIGHT: typeof C = {
  accent: "#12805c",
  accentBright: "#046b45", // deepened emerald hero for white
  dim: "#4a5952",
  ok: "#1b7a44",
  warn: "#9a7b00",
  error: "#b32e14",
  magenta: "#2f8f68",
  orange: "#2b3b34", // dark warm-neutral ink — white itself won't show on white
  fg: "#16211c", // near-black ink with a faint jade cast
  heroGradient: ["#0b6b47", "#065a3b", "#03231a"] as readonly string[],
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
