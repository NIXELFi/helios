import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** `getCurrentWindow()` throws outside a real Tauri webview (vitest/jsdom,
 *  `vite:dev` in a plain browser) — callers treat null as "no window". */
export function tauriWindow(): ReturnType<typeof getCurrentWindow> | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  return getCurrentWindow();
}

/** Anything a user can click or type into is never a drag handle. */
const INTERACTIVE = "button, a, input, select, textarea, [role='button'], [data-no-window-drag]";

/**
 * mousedown handler that turns an element into a window drag handle: a single
 * press starts the OS move loop, the second press of a double-click toggles
 * maximize (native title-bar behaviour). Explicit startDragging() rather than
 * `data-tauri-drag-region`, because the attribute only fires when the pressed
 * element itself carries it (children like a wordmark don't drag) and it proved
 * unreliable on the frameless Windows window.
 *
 * Used by the Windows TitleBar and, on macOS (Overlay title bar, no TitleBar),
 * by the rail brand header and module headers that sit under the invisible
 * native title bar.
 */
export function handleWindowDragMouseDown(e: ReactMouseEvent<HTMLElement>): void {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
  const win = tauriWindow();
  if (!win) return;
  if (e.detail === 2) void win.toggleMaximize();
  else void win.startDragging();
}
