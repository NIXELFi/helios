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
