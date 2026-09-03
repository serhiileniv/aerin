/**
 * Aerin's color theme: Jade — deep green, true black, true white. Green is
 * reserved for the accent (hero jade #0f8f5c + a cooler interactive jade) and
 * for success; everything else — foreground, secondary text, code warmth —
 * stays neutral black/white/gray so the ground reads as black-and-white with
 * a jade accent, not a wash of mint. Red and amber stay as functional signal
 * colors for errors/warnings — the one deliberate exception.
 * Central palette: UI code refers to roles, never raw colors, so retheming is
 * a one-file change. The palette is mutable so background detection can swap
 * in the light-terminal variants before first render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#3fae82", // cooler, lighter jade than the hero — everyday UI
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#0f8f5c", // deep, saturated jade — the stone, not neon
  /** Secondary/meta text — true neutral gray, no green cast. */
  dim: "#6e756f",
  /** Success / done — clear leaf green, distinct from the hero's blue-green. */
  ok: "#2f9e52",
  /** Warnings, in-progress, queued — golden (ansiBrightYellow), kept functional. */
  warn: "#face2f",
  /** Errors and destructive hints — rust red (ansiRed), kept functional. */
  error: "#cc371e",
  /** Plan mode, section headers, reasoning — deep teal-jade, a third hue via undertone, not tint. */
  magenta: "#1b6e63",
  /** Code accents (params, punctuation warmth) — soft warm white-gray, no green. */
  orange: "#d6d6ce",
  /** Default foreground — true near-white, no green cast. */
  fg: "#f3f3f1",
  /** Hero gradient stops (kept for brand moments): jade melting into near-black. */
  heroGradient: ["#2fa96c", "#0f8f5c", "#04211a"] as readonly string[],
};

/** Same roles re-picked for white/light terminal backgrounds. */
const LIGHT: typeof C = {
  accent: "#1b7a52",
  accentBright: "#0a5c3b", // deepened jade hero for white
  dim: "#55605a",
  ok: "#1c7a3e",
  warn: "#9a7b00",
  error: "#b32e14",
  magenta: "#12594f",
  orange: "#34342e", // dark warm-neutral ink — white itself won't show on white
  fg: "#121212", // true near-black ink, no green cast
  heroGradient: ["#0f6b47", "#0a5c3b", "#021712"] as readonly string[],
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
