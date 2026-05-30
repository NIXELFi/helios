import { useRef, useState } from "react";
import { widgetRegistry, type OverlaySession } from "@helios/widgets";
import type { CursorEmitter, ViewStateEmitter, LapSelectionEmitter, LapSelection, GpsPickerEmitter } from "@helios/lib";
import type { TileSpec } from "../workspaces/types";
import type { LoadedSession } from "../lib/session";
import { snapTile, GRID_COLS, GRID_ROWS } from "../lib/grid";

interface Props {
  spec: TileSpec;
  primary: LoadedSession;
  visibleSessions: LoadedSession[];
  cursorEmitter: CursorEmitter;
  viewState: ViewStateEmitter;
  lapSelectionEmitter: LapSelectionEmitter;
  lapSelection: LapSelection;
  gpsPickerEmitter: GpsPickerEmitter;
  editMode: boolean;
  selected: boolean;
  onSelect?: () => void;
  /** Called on pointer-up after a drag/resize, with the snapped final spec.
   *  Only invoked while editMode is true. */
  onChange?: (next: TileSpec) => void;
}

const DRAG_THRESHOLD_PX = 4;

// `captureEl`/`pointerId` record the element that actually received
// setPointerCapture so release always targets the SAME element, regardless of
// which surface (title bar or body click-shield) the up/cancel event fires on.
// Both surfaces share these handlers; capturing and releasing on whichever
// `currentTarget` happens to fire was fragile (capture on one, release attempt
// on the other → release no-ops and the pointer stays captured).
type DragState =
  | { kind: "none" }
  | { kind: "press"; clientX: number; clientY: number; captureEl: Element; pointerId: number }
  | { kind: "move"; clientX0: number; clientY0: number; dx: number; dy: number; captureEl: Element; pointerId: number }
  | { kind: "resize"; dw: number; dh: number; captureEl: Element; pointerId: number };

export function Tile({
  spec, primary, visibleSessions, cursorEmitter, viewState,
  lapSelectionEmitter, lapSelection, gpsPickerEmitter,
  editMode, selected, onSelect, onChange,
}: Props) {
  const widget = widgetRegistry.get(spec.widgetType);
  const channels = widget.requiredChannels(spec.config);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState>({ kind: "none" });

  function sliceFor(session: LoadedSession) {
    const range = session.store.extentUs();
    const known = channels.filter((id) => session.store.get(id) !== undefined);
    return {
      slice: session.store.slice(known, { startUs: range.startUs, endUs: range.endUs }),
      range,
    };
  }

  const primarySlice = sliceFor(primary);

  // Only filter out sessions whose slice came up empty when the widget
  // ASKED FOR channels — lap-aware widgets (lap_panel, time_report) declare
  // requiredChannels(): [] because they read laps from session metadata, and
  // we shouldn't drop sessions with valid laps just because we requested no
  // columns. Without this guard those widgets render "no laps detected" even
  // when channel_report (same data, different requiredChannels) shows laps.
  const overlays: OverlaySession[] = visibleSessions
    .map((s) => ({ session: s, ...sliceFor(s) }))
    .filter((entry) => channels.length === 0 || entry.slice.data.size > 0)
    .sort((a, b) => (a.session.id === primary.id ? -1 : b.session.id === primary.id ? 1 : 0))
    .map((entry) => ({
      id: entry.session.id,
      label: entry.session.label,
      color: entry.session.color,
      slice: entry.slice,
      range: entry.range,
      isPrimary: entry.session.id === primary.id,
      laps: entry.session.laps,
    }));

  const RenderC = widget.Render;

  const liveX = spec.x + (drag.kind === "move" ? drag.dx : 0);
  const liveY = spec.y + (drag.kind === "move" ? drag.dy : 0);
  const liveW = spec.w + (drag.kind === "resize" ? drag.dw : 0);
  const liveH = spec.h + (drag.kind === "resize" ? drag.dh : 0);

  function parentRect(): DOMRect | null {
    return containerRef.current?.parentElement?.getBoundingClientRect() ?? null;
  }

  // Release whatever element the drag captured the pointer on (not the element
  // that happens to be firing the up/cancel event). Guarded so an extra
  // pointerup/pointercancel on the other surface is a harmless no-op.
  function releaseCapture(state: DragState) {
    if (state.kind === "none") return;
    const { captureEl, pointerId } = state;
    if (captureEl instanceof Element && (captureEl as Element & { hasPointerCapture?: (id: number) => boolean }).hasPointerCapture?.(pointerId)) {
      (captureEl as Element & { releasePointerCapture: (id: number) => void }).releasePointerCapture(pointerId);
    }
  }

  // ─── move drag (title bar + body click-shield) ───────────────────────────
  function onMoveDown(e: React.PointerEvent<HTMLElement>) {
    if (!editMode || e.button !== 0) return;
    // Ignore a second pointerdown while a drag is already in flight (e.g. the
    // body shield receiving an event after the title bar already captured).
    if (drag.kind !== "none") return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "press", clientX: e.clientX, clientY: e.clientY, captureEl: e.currentTarget, pointerId: e.pointerId });
  }

  function onMoveMove(e: React.PointerEvent<HTMLElement>) {
    if (!editMode) return;
    const rect = parentRect();
    if (!rect) return;
    if (drag.kind === "press") {
      const dxPx = e.clientX - drag.clientX;
      const dyPx = e.clientY - drag.clientY;
      if (Math.abs(dxPx) >= DRAG_THRESHOLD_PX || Math.abs(dyPx) >= DRAG_THRESHOLD_PX) {
        setDrag({
          kind: "move",
          clientX0: drag.clientX, clientY0: drag.clientY,
          dx: dxPx / rect.width, dy: dyPx / rect.height,
          captureEl: drag.captureEl, pointerId: drag.pointerId,
        });
      }
    } else if (drag.kind === "move") {
      setDrag({
        ...drag,
        dx: (e.clientX - drag.clientX0) / rect.width,
        dy: (e.clientY - drag.clientY0) / rect.height,
      });
    }
  }

  function onMoveUp(e: React.PointerEvent<HTMLElement>) {
    if (!editMode) return;
    // Only the element that captured this pointer should finish the drag; a
    // stray up/cancel on the OTHER surface is ignored so we don't double-finish.
    if (drag.kind === "none" || drag.pointerId !== e.pointerId) return;
    releaseCapture(drag);
    if (drag.kind === "press") {
      onSelect?.();
    } else if (drag.kind === "move" && onChange) {
      const snapped = snapTile({ ...spec, x: liveX, y: liveY });
      if (snapped.x !== spec.x || snapped.y !== spec.y) onChange(snapped);
    }
    setDrag({ kind: "none" });
  }

  // ─── resize drag (corner handle) ─────────────────────────────────────────
  function onResizeDown(e: React.PointerEvent<HTMLElement>) {
    if (!editMode || e.button !== 0) return;
    if (drag.kind !== "none") return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", dw: 0, dh: 0, captureEl: e.currentTarget, pointerId: e.pointerId });
  }

  function onResizeMove(e: React.PointerEvent<HTMLElement>) {
    if (drag.kind !== "resize") return;
    const rect = parentRect();
    if (!rect) return;
    const targetW = (e.clientX - rect.left) / rect.width - spec.x;
    const targetH = (e.clientY - rect.top) / rect.height - spec.y;
    setDrag({ ...drag, dw: targetW - spec.w, dh: targetH - spec.h });
  }

  function onResizeUp(e: React.PointerEvent<HTMLElement>) {
    if (drag.kind !== "resize" || drag.pointerId !== e.pointerId) return;
    releaseCapture(drag);
    if (onChange) {
      const snapped = snapTile({ ...spec, w: liveW, h: liveH });
      if (snapped.w !== spec.w || snapped.h !== spec.h) onChange(snapped);
    }
    setDrag({ kind: "none" });
  }

  const editRing = selected
    ? "ring-2 ring-[#FFC627]"
    : editMode
      ? "ring-1 ring-[#2A2C32] hover:ring-[#FFC627]"
      : "";

  return (
    <div
      ref={containerRef}
      className={"absolute " + editRing}
      style={{
        left: `${liveX * 100}%`, top: `${liveY * 100}%`,
        width: `${liveW * 100}%`, height: `${liveH * 100}%`,
      }}
    >
      <div
        className={
          "bg-[#0E0E10] text-[#9097A0] text-[10px] uppercase tracking-wider px-2 py-1 border-b border-[#2A2C32] " +
          (editMode ? "cursor-grab active:cursor-grabbing select-none" : "")
        }
        onPointerDown={onMoveDown}
        onPointerMove={onMoveMove}
        onPointerUp={onMoveUp}
        onPointerCancel={onMoveUp}
      >
        {spec.id}
        {editMode && (
          <span className="ml-2 text-[#5A5F66] normal-case">
            · {Math.round(liveW * GRID_COLS)}×{Math.round(liveH * GRID_ROWS)}
          </span>
        )}
      </div>
      <div className="absolute inset-0 top-[20px] border border-[#2A2C32] border-t-0">
        <RenderC
          config={spec.config}
          slice={primarySlice.slice}
          cursorEmitter={cursorEmitter}
          timeRange={{ startUs: primarySlice.range.startUs, endUs: primarySlice.range.endUs }}
          overlays={overlays}
          viewState={viewState}
          laps={primary.laps}
          lapSelectionEmitter={lapSelectionEmitter}
          lapSelection={lapSelection}
          gpsPickerEmitter={gpsPickerEmitter}
        />
        {editMode && (
          <>
            {/* Body click-shield: doubles as a move-drag surface and selection
                target. Blocks scrub events from reaching the widget. */}
            <div
              role="button"
              aria-label={`Edit ${spec.id}`}
              onPointerDown={onMoveDown}
              onPointerMove={onMoveMove}
              onPointerUp={onMoveUp}
              onPointerCancel={onMoveUp}
              className="absolute inset-0 cursor-grab active:cursor-grabbing bg-transparent"
            />
            <div
              role="button"
              aria-label={`Resize ${spec.id}`}
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onPointerCancel={onResizeUp}
              className="absolute right-0 bottom-0 w-3 h-3 cursor-se-resize"
              style={{
                background:
                  "linear-gradient(135deg, transparent 50%, #FFC627 50%, #FFC627 65%, transparent 65%, transparent 75%, #FFC627 75%, #FFC627 90%, transparent 90%)",
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
