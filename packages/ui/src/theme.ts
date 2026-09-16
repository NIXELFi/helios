/**
 * Helios design tokens + theme runtime.
 *
 * The palette lives in ONE place: the `PALETTES` table below. Tailwind reads
 * it through CSS variables (see apps/desktop/src/styles.css — `--helios-*`
 * channel triplets on :root, overridden under [data-theme="light"]), and
 * imperative code (canvas widgets, uPlot, SVG attributes) reads the same
 * values through `tc()` at draw time so both themes render correctly.
 *
 * Adding a token: add it to `TokenName`, both palettes, the tailwind config
 * and the CSS :root blocks. Status/accent colors (gold, danger, traces) are
 * NOT tokens — they are the same in both themes by design.
 */

export type ThemeName = "dark" | "light";
export type ThemePref = ThemeName | "system";

export type TokenName =
  | "base" // page / window background
  | "panel" // raised surfaces: rail, cards, dialogs
  | "deep" // recessed wells (inputs, code)
  | "line" // hairline borders
  | "grid" // chart grid lines (quieter than line)
  | "text" // primary text
  | "dim" // secondary text
  | "muted" // tertiary text, disabled, axis ticks
  | "onGold" // text on a gold surface (dark in both themes)
  | "gold"
  | "maroon";

/** Hex per token per theme. Keep in sync with styles.css :root blocks. */
export const PALETTES: Record<ThemeName, Record<TokenName, string>> = {
  dark: {
    base: "#0E0E10",
    panel: "#16171B",
    deep: "#0B0B0D",
    line: "#2A2C32",
    grid: "#23252B",
    text: "#D8DCE2",
    dim: "#9097A0",
    muted: "#5A5F66",
    onGold: "#0E0E10",
    gold: "#FFC627",
    maroon: "#8C1D40",
  },
  light: {
    base: "#F4F5F7",
    panel: "#FFFFFF",
    deep: "#E9EBEF",
    line: "#D6DAE1",
    grid: "#E6E8EE",
    text: "#1B1D22",
    dim: "#5B6270",
    muted: "#8A909B",
    onGold: "#0E0E10",
    gold: "#E0A800",
    maroon: "#8C1D40",
  },
};

/** CSS-variable channel triplet ("14 14 16") for a hex color. */
export function hexToChannels(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/** Legacy shape kept for older imports; values follow the ACTIVE theme. */
export const theme = {
  colors: {
    get base() { return tc("base"); },
    get panel() { return tc("panel"); },
    get line() { return tc("line"); },
    get text() { return tc("text"); },
    get dim() { return tc("dim"); },
    get maroon() { return tc("maroon"); },
    get gold() { return tc("gold"); },
    get chartGrid() { return tc("grid"); },
    get chartAxis() { return tc("muted"); },
  },
  font: {
    sans: 'Inter, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
} as const;

/** 12-color trace palette tuned for dark backgrounds. */
export const tracePalette = [
  "#FFB800", "#4FC3F7", "#66BB6A", "#FF8A65",
  "#BA68C8", "#9CCC65", "#26A69A", "#EF5350",
  "#5C6BC0", "#FFCA28", "#26C6DA", "#AB47BC",
] as const;

/* ───────────────────────── runtime ───────────────────────── */

let current: ThemeName = "dark";
let version = 0;
const listeners = new Set<(t: ThemeName) => void>();
let mediaUnsub: (() => void) | null = null;

export function currentTheme(): ThemeName {
  return current;
}

/** Bumps on every applied theme change; hooks key off it to remount canvases. */
export function themeVersion(): number {
  return version;
}

/** Theme color for imperative drawing (canvas, uPlot, SVG attributes).
 *  Returns the hex for the ACTIVE theme; call at draw time, not module scope. */
export function tc(name: TokenName): string {
  return PALETTES[current][name];
}

/** Same as tc() with an alpha, as an rgba() string — for translucent
 *  overlays that used to be hardcoded "rgba(14,14,16,0.85)". */
export function tca(name: TokenName, alpha: number): string {
  const [r, g, b] = hexToChannels(PALETTES[current][name]).split(" ");
  return `rgba(${r},${g},${b},${alpha})`;
}

export function resolveTheme(pref: ThemePref): ThemeName {
  if (pref !== "system") return pref;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function setTheme(next: ThemeName): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
  }
  if (next === current && version > 0) return;
  current = next;
  version++;
  for (const l of listeners) l(next);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("helios:theme", { detail: next }));
}

/** Apply a preference. With "system", follows the OS setting live. */
export function applyTheme(pref: ThemePref): void {
  mediaUnsub?.();
  mediaUnsub = null;
  setTheme(resolveTheme(pref));
  if (pref === "system" && typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    mediaUnsub = () => mq.removeEventListener("change", onChange);
  }
}

export function subscribeTheme(listener: (t: ThemeName) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
