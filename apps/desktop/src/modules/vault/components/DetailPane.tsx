import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The Vault's right-hand details/history pane: drag its left edge to resize,
 * hide it from the path bar to give the file list the room. Both choices are
 * remembered on this computer.
 */

const WIDTH_KEY = "helios.vault.detailPane.width";
const HIDDEN_KEY = "helios.vault.detailPane.hidden";

export const DETAIL_PANE_DEFAULT_WIDTH = 320;
export const DETAIL_PANE_MIN_WIDTH = 240;
export const DETAIL_PANE_MAX_WIDTH = 760;

/** Room the rail, folder tree and a usable file list need beside the pane. */
const RESERVED_FOR_REST = 560;

/** Largest pane width this window allows: never more than 60 % of it, and
 *  always leaving room for the rail, tree and file list. */
export function maxPaneWidth(viewportWidth: number): number {
  return Math.max(
    DETAIL_PANE_MIN_WIDTH,
    Math.min(DETAIL_PANE_MAX_WIDTH, Math.floor(viewportWidth * 0.6), viewportWidth - RESERVED_FOR_REST),
  );
}

/** Clamp to the pane's limits for this window size. */
export function clampPaneWidth(width: number, viewportWidth: number): number {
  const max = maxPaneWidth(viewportWidth);
  if (!Number.isFinite(width)) return DETAIL_PANE_DEFAULT_WIDTH;
  return Math.round(Math.min(max, Math.max(DETAIL_PANE_MIN_WIDTH, width)));
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota — not worth surfacing */ }
}

export function useDetailPaneLayout() {
  const [width, setWidthState] = useState<number>(() =>
    clampPaneWidth(readNumber(WIDTH_KEY) ?? DETAIL_PANE_DEFAULT_WIDTH, window.innerWidth),
  );
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(HIDDEN_KEY) === "true"; } catch { return false; }
  });

  /** Live update while dragging; `commit` persists (on release). */
  const setWidth = useCallback((next: number, commit = false) => {
    const w = clampPaneWidth(next, window.innerWidth);
    setWidthState(w);
    if (commit) write(WIDTH_KEY, String(w));
  }, []);

  const toggleHidden = useCallback(() => {
    setHidden((h) => {
      write(HIDDEN_KEY, String(!h));
      return !h;
    });
  }, []);

  return { width, setWidth, hidden, toggleHidden };
}

export function DetailPane({
  width,
  onResize,
  hidden,
  hideWhenNarrow,
  children,
}: {
  width: number;
  onResize: (width: number, commit?: boolean) => void;
  hidden: boolean;
  /** Keep the old behaviour of not showing the empty "select a file" pane on
   *  narrow windows. */
  hideWhenNarrow: boolean;
  children: ReactNode;
}) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // The saved width is what the user chose; the pane shows as much of it as
  // the window allows right now, so shrinking or snapping the window can't
  // push the file list to nothing (and widening it again restores the choice).
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const shownWidth = clampPaneWidth(width, viewport);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: shownWidth, last: shownWidth };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The pane sits on the right, so dragging LEFT makes it wider.
    d.last = d.startWidth + (d.startX - e.clientX);
    onResize(d.last);
  };
  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    onResize(d.last, true);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+arrows = folder back/forward
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") { e.preventDefault(); onResize(shownWidth + step, true); }
    else if (e.key === "ArrowRight") { e.preventDefault(); onResize(shownWidth - step, true); }
  };

  if (hidden) return null;

  return (
    <div
      className={`relative h-full shrink-0 ${hideWhenNarrow ? "hidden lg:flex" : "flex"}`}
      style={{ width: shownWidth }}
      data-testid="vault-detail-pane"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details pane"
        aria-valuenow={shownWidth}
        aria-valuemin={DETAIL_PANE_MIN_WIDTH}
        aria-valuemax={maxPaneWidth(viewport)}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onResize(DETAIL_PANE_DEFAULT_WIDTH, true)}
        onKeyDown={onKeyDown}
        className={`absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize outline-none transition-colors hover:bg-asu-gold/40 focus-visible:bg-asu-gold/40 ${dragging ? "bg-asu-gold/50" : ""}`}
      />
      {/* While dragging, a full-window layer keeps the col-resize cursor and
          stops the file table underneath from hover-highlighting. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Path-bar toggle that shows/hides the pane. */
export function DetailPaneToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={!hidden}
      title={hidden ? "Show the details pane" : "Hide the details pane"}
      className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors hover:bg-helios-line hover:text-helios-text ${hidden ? "text-helios-dim" : "text-helios-text"}`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <rect x="10" y="3" width="4" height="10" fill="currentColor" opacity={hidden ? 0.15 : 0.6} />
      </svg>
      Details
    </button>
  );
}
