import { useSyncExternalStore } from "react";
import { subscribeTheme, themeVersion, currentTheme, type ThemeName } from "@helios/ui";

export { applyTheme, tc, tca, currentTheme, resolveTheme } from "@helios/ui";

/** Re-renders the caller when the theme changes. Use it as a `key` on canvas
 *  / uPlot hosts so they remount and redraw with the new palette. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    (cb) => subscribeTheme(() => cb()),
    themeVersion,
    themeVersion,
  );
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(
    (cb) => subscribeTheme(() => cb()),
    currentTheme,
    currentTheme,
  );
}

/** Initials-avatar tint for a stable hue. Dark: deep disc + light initials.
 *  Light: pastel disc + dark initials, so the rail and people list don't
 *  read as a row of saturated blobs on white. */
export function avatarStyle(hue: number, theme: ThemeName): { backgroundColor: string; color: string; borderColor: string } {
  return theme === "light"
    ? { backgroundColor: `hsl(${hue} 60% 90%)`, color: `hsl(${hue} 45% 32%)`, borderColor: `hsl(${hue} 45% 78%)` }
    : { backgroundColor: `hsl(${hue} 42% 20%)`, color: `hsl(${hue} 70% 76%)`, borderColor: `hsl(${hue} 38% 34%)` };
}

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

/** A data-driven colour (role tag, subteam colour) rendered as TEXT on a
 *  tinted chip. Those colours are picked to glow on dark, so in light we
 *  pull the lightness down and keep the hue; the tinted background keeps
 *  the original colour so the chip still reads as "that" colour. */
export function chipStyle(color: string, theme: ThemeName): { backgroundColor: string; color: string; boxShadow: string } {
  let text = color;
  if (theme === "light") {
    const hsl = hexToHsl(color);
    if (hsl) {
      const [h, s, l] = hsl;
      text = `hsl(${h.toFixed(0)} ${Math.round(Math.max(s, 0.45) * 100)}% ${Math.round(Math.min(l, 0.34) * 100)}%)`;
    }
  }
  return { backgroundColor: color + "22", color: text, boxShadow: `inset 0 0 0 1px ${color}${theme === "light" ? "66" : "33"}` };
}
