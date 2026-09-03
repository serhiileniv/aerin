/**
 * Aerin's color theme: Jade — deep green, true black, true white, built on
 * real named colors rather than invented ones: Emerald #50c878 (the
 * gemstone's canonical hex) as the lighter interactive tone, Dark Jade
 * #007a54 as the hero, and traditional pigment Emerald Green #046307
 * anchoring the deep end of every gradient. Success and the tertiary
 * (plan-mode/headers) role are the standard CSS greens MediumSeaGreen and
 * SeaGreen. Everything else — foreground, secondary text, code warmth —
 * stays neutral black/white/gray so the ground reads as black-and-white
 * with a jade accent, not a wash of mint. Red and amber stay as functional
 * signal colors for errors/warnings — the one deliberate exception.
 * Central palette: UI code refers to roles, never raw colors, so retheming is
 * a one-file change. The palette is mutable so background detection can swap
 * in the light-terminal variants before first render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#50c878", // Emerald — the gemstone's canonical hex
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#007a54", // Dark Jade
  /** Secondary/meta text — true neutral gray, no green cast. */
  dim: "#6e756f",
  /** Success / done — CSS MediumSeaGreen. */
  ok: "#3cb371",
  /** Warnings, in-progress, queued — golden (ansiBrightYellow), kept functional. */
  warn: "#face2f",
  /** Errors and destructive hints — rust red (ansiRed), kept functional. */
  error: "#cc371e",
  /** Plan mode, section headers, reasoning — CSS SeaGreen, a third hue via undertone, not tint. */
  magenta: "#2e8b57",
  /** Code accents (params, punctuation warmth) — soft warm white-gray, no green. */
  orange: "#d6d6ce",
  /** Default foreground — true near-white, no green cast. */
  fg: "#f3f3f1",
  /** Hero gradient stops (kept for brand moments): Emerald into Dark Jade into traditional pigment Emerald Green. */
  heroGradient: ["#50c878", "#007a54", "#046307"] as readonly string[],
};

/** Same roles re-picked for white/light terminal backgrounds. */
const LIGHT: typeof C = {
  accent: "#2e8b57", // SeaGreen — deep enough to read on white
  accentBright: "#045c3d", // deepened Dark Jade for white
  dim: "#55605a",
  ok: "#2f8f5f", // deepened MediumSeaGreen
  warn: "#9a7b00",
  error: "#b32e14",
  magenta: "#355e3b", // Hunter Green
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
