import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Workspace } from "../workspaces/types";
import { SESSION_PALETTE } from "../lib/session";
import { TabContextMenu } from "./TabContextMenu";

export interface WorkspaceTabBarProps {
  workspaces: Workspace[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, label: string) => void;
  onRecolor: (id: string, hex: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onExport: (id: string) => void;
  onExportAll: () => void;
  onImport: () => void;
}

/** Where to insert a dragged tab given the current mouse-X and the on-screen
 *  rects of every tab. Returns a "gap index" in [0..rects.length]: 0 means
 *  before the first tab, rects.length means after the last. The drop handler
 *  in App.tsx subtracts 1 when moving rightward (because the source is removed
 *  before the insertion happens), so the value here is the **pre-removal**
 *  gap index — see Task 6.3 below for the +/-1 convention. */
export function computeDropIndex(
  rects: Array<Pick<DOMRect, "left" | "right">>,
  mouseX: number,
): number {
  if (mouseX < (rects[0]?.left ?? 0)) return 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const mid = (r.left + r.right) / 2;
    if (mouseX < mid) return i;
  }
  return rects.length;
}

/** Pure math for the custom scroll indicator: given the scroller geometry,
 *  return where the thumb sits and how wide it is, both as 0..1 fractions of
 *  the track. Returns null when content doesn't overflow (no thumb needed).
 *  Exported for unit testing. */
export function computeThumb(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { leftPct: number; widthPct: number } | null {
  if (scrollWidth <= clientWidth + 0.5) return null;
  const widthPct = clientWidth / scrollWidth;
  const maxScroll = scrollWidth - clientWidth;
  const progress = maxScroll > 0 ? scrollLeft / maxScroll : 0;
  // Thumb travels from leftPct=0 to leftPct=(1 - widthPct).
  const leftPct = progress * (1 - widthPct);
  return { leftPct, widthPct };
}

function WorkspaceOverflowMenu({ onImport, onExportAll }: {
  onImport: () => void; onExportAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="More workspace actions"
        className="w-6 h-6 flex items-center justify-center text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="More workspace actions"
      >⋯</button>
      {open && (
        <div className="absolute left-0 mt-1 w-56 bg-[#0E0E10] border border-[#2A2C32] z-30 text-xs">
          <button
            onClick={() => { onImport(); setOpen(false); }}
            className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]"
            title="Import workspaces from a Helios bundle"
          >Import workspaces…</button>
          <button
            onClick={() => { onExportAll(); setOpen(false); }}
            className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]"
            title="Export every workspace to a single file"
          >Export all workspaces…</button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
  const { workspaces, activeId, onSelect, onCreate, onImport, onExportAll } = props;

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Drag-reorder state
  const tabRefs = useRef<Array<HTMLElement | null>>([]);
  const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Context menu state
  const [menuFor, setMenuFor] = useState<{ workspaceId: string; x: number; y: number } | null>(null);

  // Custom scroll indicator: replaces the native horizontal scrollbar with a
  // thin yellow thumb pinned to the bottom edge of the strip. Native bar is
  // hidden via CSS (see scrollerStyle / class below). Thumb tracks scroll
  // position via a scroll listener + ResizeObserver, and supports click-drag.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ leftPct: number; widthPct: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const recompute = () => {
      setThumb(computeThumb(el.scrollLeft, el.scrollWidth, el.clientWidth));
    };
    recompute();
    el.addEventListener("scroll", recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    // Also observe the inner row, since tab adds/removes change scrollWidth
    // without triggering a resize on the scroller itself.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", recompute);
      ro.disconnect();
    };
  }, [workspaces.length]);

  // Drag-to-scroll on the thumb. Mouse-down captures, mouse-move maps the
  // delta in track-space to a delta in content-scroll-space, mouse-up
  // releases. Doing it directly with native listeners (not React synthetic)
  // so we keep receiving moves even when the cursor leaves the thumb.
  const trackRef = useRef<HTMLDivElement>(null);
  function onThumbMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    const startX = e.clientX;
    const startScrollLeft = scroller.scrollLeft;
    const trackWidth = track.clientWidth;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    if (maxScroll <= 0 || trackWidth <= 0) return;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      // Track-space delta → content-space delta. The thumb traverses
      // (1 - widthPct) * trackWidth, mapping to maxScroll content pixels.
      const widthPct = scroller.clientWidth / scroller.scrollWidth;
      const usableTrack = trackWidth * (1 - widthPct);
      const ratio = usableTrack > 0 ? maxScroll / usableTrack : 0;
      scroller.scrollLeft = Math.max(0, Math.min(maxScroll, startScrollLeft + dx * ratio));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startRename(w: Workspace) {
    setRenamingId(w.id);
    setRenameValue(w.label);
  }

  function commitRename() {
    if (renamingId === null) return;
    const trimmed = renameValue.trim();
    if (trimmed.length > 0 && trimmed !== workspaces.find((w) => w.id === renamingId)?.label) {
      props.onRename(renamingId, trimmed);
    }
    setRenamingId(null);
  }

  function cancelRename() {
    setRenamingId(null);
  }

  // Hoisted drag handlers — wired on the tablist <div> rather than each tab.
  // This keeps dropIndex updating continuously as the cursor crosses gaps and
  // empty space at the end of the strip, so a user can drop AFTER the last tab
  // by releasing in tablist whitespace.
  function onTablistDragOver(e: DragEvent) {
    if (dragSourceIndex === null) return;
    e.preventDefault();
    const rects = tabRefs.current
      .map((el) => el?.getBoundingClientRect())
      .filter(Boolean) as DOMRect[];
    setDropIndex(computeDropIndex(rects.map((r) => ({ left: r.left, right: r.right })), e.clientX));
  }
  function onTablistDrop(e: DragEvent) {
    e.preventDefault();
    if (dragSourceIndex !== null && dropIndex !== null && dropIndex !== dragSourceIndex && dropIndex !== dragSourceIndex + 1) {
      // dropIndex is the pre-removal gap index. The reorder splices out the
      // source first, then inserts at the target — when dropping RIGHTward of
      // the source we subtract 1 to account for the shift. See computeDropIndex
      // JSDoc above.
      const target = dropIndex > dragSourceIndex ? dropIndex - 1 : dropIndex;
      props.onReorder(dragSourceIndex, target);
    }
    setDragSourceIndex(null);
    setDropIndex(null);
  }

  return (
    // Outer wrapper holds two stacked things: the horizontally-scrolling
    // strip (clipped to header width) and an absolutely-positioned custom
    // scrollbar pinned to its bottom edge. Inner row stays a single line so
    // tabs never wrap and grow header height. The native horizontal
    // scrollbar is hidden via CSS so our thumb owns the visual.
    <div className="ml-3 flex-1 min-w-0 flex items-center gap-1">
    <div className="flex-1 min-w-0 relative">
    <div
      ref={scrollerRef}
      className="overflow-x-auto [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: "none" }}
    >
      <div
        role="tablist"
        aria-label="Workspaces"
        className="flex gap-1 items-center w-max"
        onDragOver={onTablistDragOver}
        onDrop={onTablistDrop}
      >
        {workspaces.map((w, i) => {
          const active = w.id === activeId;
          const isDragSource = dragSourceIndex === i;
          return (
            <div key={w.id} className="flex items-center">
              {/* Drop indicator: shown before tab i when dropIndex === i */}
              {dropIndex === i && dragSourceIndex !== null && dragSourceIndex !== i && dragSourceIndex !== i - 1 && (
                <span className="w-0.5 h-4 bg-[#FFC627] rounded-full mr-0.5 shrink-0" aria-hidden />
              )}
            <button
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(w.id)}
              ref={(el) => { tabRefs.current[i] = el; }}
              draggable={renamingId !== w.id}
              onDragStart={(e) => {
                setDragSourceIndex(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", w.id);
              }}
              onDragEnd={() => { setDragSourceIndex(null); setDropIndex(null); }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor({ workspaceId: w.id, x: e.clientX, y: e.clientY });
              }}
              className={
                "flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
                (isDragSource ? "opacity-50 " : "") +
                (active
                  ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                  : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
              }
            >
              <span
                data-testid="workspace-swatch"
                aria-hidden
                className="inline-block w-2 h-2 rounded-sm"
                style={{ background: w.color }}
              />
              {renamingId === w.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="bg-transparent border-b border-current px-0.5 outline-none w-24"
                />
              ) : (
                <span onDoubleClick={(e) => { e.stopPropagation(); startRename(w); }}>{w.label}</span>
              )}
            </button>
            </div>
          );
        })}
        {/* Drop indicator after the last tab */}
        {dropIndex === workspaces.length && dragSourceIndex !== null && dragSourceIndex !== workspaces.length - 1 && (
          <span className="w-0.5 h-4 bg-[#FFC627] rounded-full ml-0.5 shrink-0" aria-hidden />
        )}
      </div>
    </div>{/* end scroller */}

      {/* Custom scrollbar — thin yellow thumb pinned to the bottom edge of
          the strip. Track is pointer-events-none so it doesn't intercept
          clicks on tabs above; the thumb itself re-enables them so users
          can drag to scroll. */}
      {thumb && (
        <div
          ref={trackRef}
          className="absolute -bottom-2 left-0 right-0 h-[4px] pointer-events-none"
          aria-hidden
        >
          <div
            onMouseDown={onThumbMouseDown}
            className="absolute top-0 h-full bg-[#FFC627]/50 hover:bg-[#FFC627] rounded-full pointer-events-auto cursor-grab active:cursor-grabbing transition-colors"
            style={{ left: `${thumb.leftPct * 100}%`, width: `${thumb.widthPct * 100}%` }}
          />
        </div>
      )}
    </div>{/* end scroller-relative wrapper */}
      <button
        onClick={onCreate}
        aria-label="New workspace"
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-xs border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Create a new empty workspace"
      >+</button>
      <WorkspaceOverflowMenu onImport={onImport} onExportAll={onExportAll} />

      {menuFor && (() => {
        const target = workspaces.find((w) => w.id === menuFor.workspaceId);
        if (!target) return null;
        return (
          <TabContextMenu
            anchor={{ x: menuFor.x, y: menuFor.y }}
            canDelete={workspaces.length > 1}
            palette={SESSION_PALETTE}
            onRename={() => startRename(target)}
            onRecolor={(hex) => props.onRecolor(target.id, hex)}
            onDuplicate={() => props.onDuplicate(target.id)}
            onExport={() => props.onExport(target.id)}
            onDelete={() => props.onDelete(target.id)}
            onClose={() => setMenuFor(null)}
          />
        );
      })()}
    </div>
  );
}
