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
