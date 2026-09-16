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
    dim: "#4F5665",
    muted: "#7C838F",
    onGold: "#0E0E10",
    gold: "#D69E00",
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

function commitTheme(next: ThemeName): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
  }
  current = next;
  version++;
  for (const l of listeners) l(next);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("helios:theme", { detail: next }));
}

type DocWithVT = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => {
    finished: Promise<void>;
    ready?: Promise<void>;
    updateCallbackDone?: Promise<void>;
  };
};

/** Apply a theme with a crossfade. The View Transitions API snapshots the
 *  old frame, lets us swap tokens + remount canvases underneath, then fades
 *  to the new frame (~350 ms, see styles.css ::view-transition-*). Where the
 *  API is missing, a short colour transition class does the softening.
 *  Honours prefers-reduced-motion; the very first apply at boot is instant. */
function setTheme(next: ThemeName): void {
  if (next === current && version > 0) {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    }
    return;
  }
  const doc = typeof document !== "undefined" ? (document as DocWithVT) : null;
  const firstApply = version === 0;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc || firstApply || reduce) {
    commitTheme(next);
    return;
  }
  if (typeof doc.startViewTransition === "function") {
    doc.documentElement.classList.add("helios-theme-switching");
    const vt = doc.startViewTransition(async () => {
      commitTheme(next);
      // Let React commit the remounted panes before the new frame is captured.
      // Rendering is paused inside the DOM-update phase, so rAF never fires
      // here — a macrotask hop is what lets React flush its batched updates.
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    // A transition can be skipped/aborted (another one started, the tab was
    // hidden, a screenshot tool stalled the frame) — that is not an error for
    // us: the DOM swap already happened. Swallow the rejections.
    vt.ready?.catch(() => {});
    vt.updateCallbackDone?.catch(() => {});
    void vt.finished
      .catch(() => {})
      .then(() => doc.documentElement.classList.remove("helios-theme-switching"));
    return;
  }
  doc.documentElement.classList.add("helios-theme-fade");
  commitTheme(next);
  window.setTimeout(() => doc.documentElement.classList.remove("helios-theme-fade"), 400);
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
