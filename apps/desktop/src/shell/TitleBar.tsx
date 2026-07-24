import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import heliosIcon from "../assets/helios-icon.png";

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
 * Dragging: handled EXPLICITLY via startDragging() on mousedown, not via
 * `data-tauri-drag-region` — the declarative attribute's injected handler
 * proved unreliable on a frameless Windows window (drag simply didn't
 * engage), and mixing both mechanisms would double-fire the double-click
 * maximize. The window-control buttons opt out via `closest("button")`.
 * Design per the approved 2026-06-16 mockup: logo + HELIOS wordmark +
 * module crumb left, min/max/close right, red close hover.
 */
export function TitleBar({ context }: { context: string | null }) {
  const [maximized, setMaximized] = useState(false);

  function handleDragMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // The min/max/close buttons are click targets, never drag handles.
    if ((e.target as HTMLElement).closest("button")) return;
    const win = tauriWindow();
    if (!win) return;
    // Second press of a double-click arrives as mousedown with detail 2 —
    // native title bars toggle maximize on it; a single press starts the
    // OS move loop (which also swallows the matching mouseup).
    if (e.detail === 2) void win.toggleMaximize();
    else void win.startDragging();
  }

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
      onMouseDown={handleDragMouseDown}
      className="flex h-[38px] flex-none select-none items-center border-b border-helios-line bg-gradient-to-b from-[#15161B] to-[#0E0E10]"
    >
      <div className="flex items-center gap-[9px] pl-[13px]">
        <img
          src={heliosIcon}
          alt=""
          draggable={false}
          className="size-[18px] rounded-[4px] shadow-[0_0_10px_rgba(255,198,39,0.35)]"
        />
        <span className="font-helios text-[12.5px] text-asu-gold">
          HELIOS
        </span>
        {context && (
          <span className="ml-[5px] border-l border-helios-line pl-[11px] text-xs text-helios-dim">
            <b className="font-semibold text-helios-text">
              {context}
            </b>
          </span>
        )}
      </div>
      <div className="flex-1 self-stretch" />
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
