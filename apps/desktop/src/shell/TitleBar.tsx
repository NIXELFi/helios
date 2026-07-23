import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** `getCurrentWindow()` throws outside a real Tauri webview (vitest/jsdom,
 *  `vite:dev` in a plain browser) — the bar still renders there, its window
 *  controls just no-op. */
function tauriWindow(): ReturnType<typeof getCurrentWindow> | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  return getCurrentWindow();
}

/** Height of the custom title bar. Mirrored into the `--helios-titlebar-h`
 *  CSS variable (declared 0px in styles.css) so full-height `fixed` overlays
 *  (e.g. the PM task sheet) can stay clear of the bar without knowing whether
 *  this platform renders one. */
const TITLEBAR_HEIGHT_PX = 38;

/**
 * Custom in-app title bar for platforms where the native frame is disabled
 * (Windows: `decorations: false` in src-tauri/tauri.windows.conf.json).
 * macOS keeps its native traffic lights via `titleBarStyle: "Overlay"` and
 * does NOT render this component.
 *
 * The whole bar is a Tauri drag region (double-click = maximize/restore is
 * handled natively by the drag region); the window-control buttons opt out
 * simply by not carrying the attribute. Design per the approved 2026-06-16
 * mockup: gold logo chip + HELIOS wordmark + module crumb left, min/max/close
 * right, red close hover.
 */
export function TitleBar({ context }: { context: string | null }) {
  const [maximized, setMaximized] = useState(false);

  // Publish the bar height app-wide while mounted (see TITLEBAR_HEIGHT_PX).
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--helios-titlebar-h",
      `${TITLEBAR_HEIGHT_PX}px`,
    );
    return () => {
      document.documentElement.style.removeProperty("--helios-titlebar-h");
    };
  }, []);

  // Track maximized state so the middle button can swap its glyph
  // (maximize ⇄ restore). Resize events cover every path that changes it:
  // our button, drag-region double-click, Win+arrow, edge snapping.
  useEffect(() => {
    const win = tauriWindow();
    if (!win) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      win.isMaximized().then((m) => {
        if (!disposed) setMaximized(m);
      }).catch(() => {});
    };
    refresh();
    win.onResized(refresh).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex h-[38px] flex-none select-none items-center border-b border-helios-line bg-gradient-to-b from-[#15161B] to-[#0E0E10]"
    >
      {/* Children of a drag region swallow the drag mousedown unless they
          carry the attribute themselves — every decorative element repeats it. */}
      <div data-tauri-drag-region className="flex items-center gap-[9px] pl-[13px]">
        <div
          data-tauri-drag-region
          className="size-[15px] rounded-[3px] bg-gradient-to-br from-asu-gold to-[#D99E00] shadow-[0_0_10px_rgba(255,198,39,0.45)]"
        />
        <span
          data-tauri-drag-region
          className="font-helios text-[12.5px] text-asu-gold"
        >
          HELIOS
        </span>
        {context && (
          <span
            data-tauri-drag-region
            className="ml-[5px] border-l border-helios-line pl-[11px] text-xs text-helios-dim"
          >
            <b data-tauri-drag-region className="font-semibold text-helios-text">
              {context}
            </b>
          </span>
        )}
      </div>
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      <div className="flex h-full">
        <button
          type="button"
          title="Minimize"
          aria-label="Minimize"
          onClick={() => void tauriWindow()?.minimize()}
          className="flex h-full w-[46px] cursor-pointer items-center justify-center text-helios-dim transition-colors hover:bg-white/[0.07] hover:text-helios-text"
        >
          <svg viewBox="0 0 11 11" className="size-[11px]">
            <rect x="1" y="5.2" width="9" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => void tauriWindow()?.toggleMaximize()}
          className="flex h-full w-[46px] cursor-pointer items-center justify-center text-helios-dim transition-colors hover:bg-white/[0.07] hover:text-helios-text"
        >
          {maximized ? (
            <svg viewBox="0 0 11 11" className="size-[11px]">
              <path
                d="M3.5 3.5 V1.5 H9.5 V7.5 H7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
              <rect
                x="1.5"
                y="3.5"
                width="6"
                height="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 11 11" className="size-[11px]">
              <rect
                x="1.5"
                y="1.5"
                width="8"
                height="8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          title="Close"
          aria-label="Close"
          onClick={() => void tauriWindow()?.close()}
          className="flex h-full w-[46px] cursor-pointer items-center justify-center text-helios-dim transition-colors hover:bg-[#EF5350] hover:text-white"
        >
          <svg viewBox="0 0 11 11" className="size-[11px]">
            <path
              d="M1.2 1.2 L9.8 9.8 M9.8 1.2 L1.2 9.8"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
