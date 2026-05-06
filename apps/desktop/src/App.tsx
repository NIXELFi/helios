import { useEffect, useRef, useState } from "react";
import { CursorEmitter, formatClock } from "@helios/lib";
import { loadAllSessions, type LoadProgress } from "./lib/load-sample";
import type { LoadedSession } from "./lib/session";
import type { TileSpec, Workspace } from "./workspaces/types";
import { loadWorkspaces, saveWorkspaces, resetToBuiltins } from "./lib/workspace-storage";
import { findNextFreeSlot, snapAllToGrid, GRID_COLS, GRID_ROWS } from "./lib/grid";
import {
  type MathChannel, applyMathChannels, loadMathChannels, saveMathChannels,
} from "./lib/math-channels";
import { useUpdater } from "./lib/use-updater";
import { Tile } from "./components/Tile";
import { UpdatesPill } from "./components/UpdatesPill";
import { UpdateModal } from "./components/UpdateModal";
import { SessionPanel } from "./components/SessionPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { ChannelsModal } from "./components/ChannelsModal";
import { AddTileModal } from "./components/AddTileModal";
import { MathChannelsModal } from "./components/MathChannelsModal";
import { LoadingScreen } from "./components/LoadingScreen";
import { ConfirmDialog } from "./components/ConfirmDialog";

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => loadWorkspaces());
  const [workspaceId, setWorkspaceId] = useState(() => {
    const list = loadWorkspaces();
    return list[0]?.id ?? "overview";
  });
  const [sessions, setSessions] = useState<LoadedSession[] | null>(null);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emitter] = useState(() => new CursorEmitter());
  const [editMode, setEditMode] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [addTileOpen, setAddTileOpen] = useState(false);
  const [mathChannelsOpen, setMathChannelsOpen] = useState(false);
  const [mathChannels, setMathChannelsState] = useState<MathChannel[]>(() => loadMathChannels());
  const [mathErrors, setMathErrors] = useState<Map<string, string>>(new Map());
  const updater = useUpdater();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    heading: string;
    body: string;
    tone?: "default" | "danger";
    onConfirm: () => void;
  } | null>(null);
  const [playing, setPlaying] = useState(false);
  // Progress reported by the loader; drives the splash bar. The "stages" are
  // (a) per-session load via loadAllSessions's onProgress, and (b) a single
  // final "Computing math channels" beat we add ourselves.
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({
    label: "Starting…", loaded: 0, total: 1,
  });

  useEffect(() => {
    loadAllSessions((p) => setLoadProgress(p))
      .then((loaded) => {
        setLoadProgress({
          label: "Computing math channels",
          loaded: loaded.length,
          total: loaded.length + 1,
        });
        const initialMath = loadMathChannels();
        const errors = new Map<string, string>();
        for (const session of loaded) {
          const r = applyMathChannels(session.store, initialMath);
          for (const [k, v] of r.errors) errors.set(k, v);
        }
        setMathErrors(errors);
        setSessions(loaded);
        const firstVisible = loaded.find((s) => s.visible) ?? loaded[0];
        setPrimaryId(firstVisible?.id ?? null);
        setLoadProgress({
          label: "Ready",
          loaded: loaded.length + 1,
          total: loaded.length + 1,
        });
      })
      .catch((e) => setError(String(e)));
  }, []);

  // When the updater transitions into "available" (after the auto-check on
  // launch), auto-open the modal once. The user can dismiss with "Remind me
  // later"; we don't auto-reopen on every state change to avoid being annoying.
  useEffect(() => {
    if (updater.state.kind === "available") setUpdateModalOpen(true);
  }, [updater.state.kind]);

  if (error || !sessions || !primaryId) {
    const denom = Math.max(1, loadProgress.total);
    return (
      <LoadingScreen
        progress={loadProgress.loaded / denom}
        stage={loadProgress.label}
        error={error}
      />
    );
  }

  const visibleSessions = sessions.filter((s) => s.visible);
  const primary = sessions.find((s) => s.id === primaryId) ?? visibleSessions[0] ?? sessions[0]!;
  const ext = primary.store.extentUs();
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]!;
  const selectedTile = workspace.tiles.find((t) => t.id === selectedTileId) ?? null;

  function toggleVisibility(id: string) {
    setSessions((prev) => {
      if (!prev) return prev;
      const next = prev.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s));
      const stillVisible = next.find((s) => s.id === primaryId)?.visible;
      if (!stillVisible) {
        const fallback = next.find((s) => s.visible);
        if (fallback) setPrimaryId(fallback.id);
      }
      return next;
    });
  }

  /** Apply a workspaces update via functional setState, then persist. Using
   *  the functional form here is critical: every workspace mutation reads
   *  the LATEST committed state instead of whatever was in scope when the
   *  closure was created, so a stale-closure can't quietly clobber a
   *  previous edit (the "field reverts instantly after edit" bug). */
  function commitWorkspaces(updater: (prev: Workspace[]) => Workspace[]) {
    setWorkspaces((prev) => {
      const next = updater(prev);
      saveWorkspaces(next);
      return next;
    });
  }

  function updateTile(nextTile: TileSpec) {
    commitWorkspaces((prev) => prev.map((w) => (w.id !== workspaceId
      ? w
      : { ...w, tiles: w.tiles.map((t) => (t.id === nextTile.id ? nextTile : t)) }
    )));
  }

  function deleteTile(tileId: string) {
    commitWorkspaces((prev) => prev.map((w) => (w.id !== workspaceId
      ? w
      : { ...w, tiles: w.tiles.filter((t) => t.id !== tileId) }
    )));
    if (selectedTileId === tileId) setSelectedTileId(null);
  }

  function duplicateTile(tileId: string) {
    const orig = workspace.tiles.find((t) => t.id === tileId);
    if (!orig) return;
    const existingIds = new Set(workspace.tiles.map((t) => t.id));
    let newId = `${orig.id}-copy`;
    let i = 2;
    while (existingIds.has(newId)) newId = `${orig.id}-copy-${i++}`;
    const slot = findNextFreeSlot(
      workspace.tiles,
      Math.max(2, Math.round(orig.w * GRID_COLS)),
      Math.max(2, Math.round(orig.h * GRID_ROWS)),
    );
    const dupe: TileSpec = { ...orig, id: newId, ...slot };
    commitWorkspaces((prev) => prev.map((w) => (w.id !== workspaceId
      ? w
      : { ...w, tiles: [...w.tiles, dupe] }
    )));
    setSelectedTileId(newId);
  }

  function handleAddTile(entry: Omit<TileSpec, "x" | "y" | "w" | "h"> & { defaultCellsW: number; defaultCellsH: number }) {
    const slot = findNextFreeSlot(workspace.tiles, entry.defaultCellsW, entry.defaultCellsH);
    const tile: TileSpec = {
      id: entry.id,
      widgetType: entry.widgetType,
      config: entry.config,
      ...slot,
    };
    commitWorkspaces((prev) => prev.map((w) => (w.id !== workspaceId
      ? w
      : { ...w, tiles: [...w.tiles, tile] }
    )));
    setSelectedTileId(tile.id);
  }

  function handleSnapToGrid() {
    commitWorkspaces((prev) => prev.map((w) => (w.id !== workspaceId ? w : snapAllToGrid(w))));
  }

  function handleResetWorkspaces() {
    setConfirmState({
      heading: "Reset all workspaces?",
      body: "Reset all workspaces to their built-in defaults? Unsaved edits will be lost.",
      tone: "danger",
      onConfirm: () => {
        const fresh = resetToBuiltins();
        setWorkspaces(fresh);
        setSelectedTileId(null);
        setConfirmState(null);
      },
    });
  }

  /** Replace the math-channel set, persist, and re-apply against every loaded
   *  session. Old math-channel ids are removed from each store first so a
   *  rename/delete doesn't leave stale columns behind. */
  function handleMathChannelsChange(next: MathChannel[]) {
    setMathChannelsState(next);
    saveMathChannels(next);
    if (!sessions) return;
    const allOldIds = new Set([...mathChannels.map((m) => m.id), ...next.map((m) => m.id)]);
    const errors = new Map<string, string>();
    for (const session of sessions) {
      for (const id of allOldIds) session.store.removeChannel(id);
      const r = applyMathChannels(session.store, next);
      for (const [k, v] of r.errors) errors.set(k, v);
    }
    setMathErrors(errors);
  }

  function handleToggleEditMode() {
    setEditMode((prev) => {
      const next = !prev;
      if (!next) setSelectedTileId(null);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-screen bg-[#0E0E10] text-[#D8DCE2]">
      <header className="h-10 flex items-center px-3 border-b border-[#2A2C32] text-xs">
        <span className="font-helios text-sm text-[#FFC627]">HELIOS</span>
        <span className="ml-3 text-[#7B8088]">{primary.label}</span>
        <span className="ml-2 text-[#7B8088]">·</span>
        <div className="ml-2 flex gap-1">
          {workspaces.map((w) => {
            const active = w.id === workspaceId;
            return (
              <button
                key={w.id}
                onClick={() => { setWorkspaceId(w.id); setSelectedTileId(null); }}
                className={
                  "px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
                  (active
                    ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                    : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
                }
              >
                {w.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setChannelsOpen(true)}
            className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
            title={`Inspect channels in ${primary.label}`}
          >
            Channels
          </button>
          <button
            onClick={() => setMathChannelsOpen(true)}
            className={
              "px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
              (mathErrors.size > 0
                ? "bg-[#16171B] text-[#EF5350] border-[#EF5350]"
                : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
            }
            title={mathErrors.size > 0
              ? `${mathErrors.size} math channel(s) failed to compile`
              : "Define computed channels by formula"}
          >
            ƒ Math {mathChannels.length > 0 ? `(${mathChannels.length})` : ""}
          </button>
          <button
            onClick={handleToggleEditMode}
            className={
              "px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
              (editMode
                ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
            }
            title={editMode ? "Exit edit mode" : "Edit workspace"}
          >
            {editMode ? "Done editing" : "Edit"}
          </button>
          {editMode && (
            <>
              <button
                onClick={() => setAddTileOpen(true)}
                className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
                title="Add a tile"
              >
                + Add tile
              </button>
              <button
                onClick={handleSnapToGrid}
                className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
                title="Snap every tile's position and size to the grid; sizes are preserved"
              >
                Snap to grid
              </button>
              <button
                onClick={handleResetWorkspaces}
                className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#7B8088] hover:text-[#EF5350] hover:border-[#EF5350] rounded-sm cursor-pointer transition-colors"
                title="Reset every workspace to its built-in default"
              >
                Reset all
              </button>
            </>
          )}
          <PlaybackControls emitter={emitter} ext={ext} playing={playing} onPlayingChange={setPlaying} />
          <UpdatesPill
            state={updater.state}
            onClick={() => {
              if (updater.state.kind === "up_to_date" || updater.state.kind === "offline") {
                updater.recheck();
              } else if (updater.state.kind === "available" || updater.state.kind === "downloading" || updater.state.kind === "installing") {
                setUpdateModalOpen(true);
              }
            }}
          />
          <span className="font-mono-num"><CursorClock emitter={emitter} /></span>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <SessionPanel
          sessions={sessions}
          primaryId={primary.id}
          onToggleVisibility={toggleVisibility}
          onSetPrimary={setPrimaryId}
        />
        <main className="flex-1 relative">
          {editMode && <GridOverlay />}
          {workspace.tiles.map((spec) => (
            <Tile
              key={spec.id}
              spec={spec}
              primary={primary}
              visibleSessions={visibleSessions}
              cursorEmitter={emitter}
              editMode={editMode}
              selected={editMode && spec.id === selectedTileId}
              onSelect={() => setSelectedTileId(spec.id)}
              onChange={updateTile}
            />
          ))}
        </main>
        {editMode && selectedTile && (
          <ConfigPanel
            tile={selectedTile}
            onChange={updateTile}
            onClose={() => setSelectedTileId(null)}
            onDuplicate={() => duplicateTile(selectedTile.id)}
            onDelete={() => deleteTile(selectedTile.id)}
            availableChannels={primary.store.list()}
          />
        )}
      </div>

      <footer className="h-6 flex items-center px-3 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
        {visibleSessions.length} session{visibleSessions.length === 1 ? "" : "s"} visible
        {" · "}primary: {primary.store.list().length} channels
        {" · "}range {(ext.endUs - ext.startUs) / 1_000_000}s
        {" · "}{workspace.tiles.length} tile{workspace.tiles.length === 1 ? "" : "s"}
        {editMode && <span className="ml-2 text-[#FFC627]">· editing</span>}
      </footer>

      {channelsOpen && (
        <ChannelsModal
          channels={primary.store.list()}
          sessionLabel={primary.label}
          onClose={() => setChannelsOpen(false)}
        />
      )}
      {addTileOpen && (
        <AddTileModal
          existingIds={workspace.tiles.map((t) => t.id)}
          onAdd={handleAddTile}
          onClose={() => setAddTileOpen(false)}
        />
      )}
      {mathChannelsOpen && (
        <MathChannelsModal
          channels={mathChannels}
          errors={mathErrors}
          availableChannels={primary.store.list().filter((c) => c.source !== "math")}
          onChange={handleMathChannelsChange}
          onClose={() => setMathChannelsOpen(false)}
        />
      )}
      {updateModalOpen && (
        <UpdateModal
          state={updater.state}
          playbackBlocked={playing}
          onInstall={() => updater.installAndRelaunch()}
          onClose={() => setUpdateModalOpen(false)}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          heading={confirmState.heading}
          body={confirmState.body}
          tone={confirmState.tone}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  );
}

function CursorClock({ emitter }: { emitter: CursorEmitter }) {
  const [t, setT] = useState(emitter.get());
  useEffect(() => emitter.subscribe(setT), [emitter]);
  return <>{formatClock(t)}</>;
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

/** Drives the cursor emitter at wall-clock rate (modulated by `speed`) when
 *  playing. Uses requestAnimationFrame to advance once per paint, comparing
 *  emitter.get() against the last value we wrote so a user scrub during
 *  playback re-anchors the start instead of fighting with playback. Wraps
 *  to the session start when the cursor passes the end so a casual press
 *  of play loops the lap rather than dead-stopping. */
function PlaybackControls({
  emitter, ext, playing, onPlayingChange,
}: {
  emitter: CursorEmitter;
  ext: { startUs: number; endUs: number };
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
}) {
  const setPlaying = onPlayingChange;
  const [speed, setSpeed] = useState<number>(1);
  // Live refs the rAF loop reads so we don't have to re-arm it whenever
  // speed/extents change.
  const speedRef = useRef(speed); speedRef.current = speed;
  const extRef = useRef(ext); extRef.current = ext;

  useEffect(() => {
    if (!playing) return;
    let rafId: number;
    let wallStartMs = performance.now();
    let cursorStartUs = emitter.get();
    let lastWrittenUs = cursorStartUs;
    // If the cursor sits at (or past) the end when play is hit, restart from
    // the beginning so a fresh press always plays the lap rather than no-op.
    if (cursorStartUs >= extRef.current.endUs - 1000) {
      cursorStartUs = extRef.current.startUs;
      emitter.emit(cursorStartUs);
      lastWrittenUs = cursorStartUs;
    }

    const tick = () => {
      // External scrub since our last write? Anchor to the new spot.
      const currentUs = emitter.get();
      if (currentUs !== lastWrittenUs) {
        wallStartMs = performance.now();
        cursorStartUs = currentUs;
      }
      const wallElapsedMs = performance.now() - wallStartMs;
      // Round to integer microseconds. Subscribers that feed cursor time
      // into BigInt() (sample-at binary search, gps-track index lookup,
      // etc.) throw on fractional values and silently drop the frame —
      // see v2_changes/04. Without this round the strip chart cursor
      // moves but every gauge / GPS / numeric widget stays frozen.
      let next = Math.round(cursorStartUs + wallElapsedMs * 1000 * speedRef.current);
      if (next >= extRef.current.endUs) {
        next = extRef.current.startUs;
        wallStartMs = performance.now();
        cursorStartUs = next;
      }
      emitter.emit(next);
      lastWrittenUs = next;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, emitter]);

  // Spacebar = play/pause when no input is focused. Common media-player
  // convention; saves a hand-trip to the mouse during analysis.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      setPlaying(!playing);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setPlaying(!playing)}
        className={
          "w-7 h-6 flex items-center justify-center text-xs border rounded-sm cursor-pointer transition-colors " +
          (playing
            ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627]"
            : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
        }
        title={playing ? "Pause (Space)" : "Play (Space)"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        className="bg-[#16171B] text-[#D8DCE2] border border-[#2A2C32] hover:border-[#FFC627] rounded-sm px-1 h-6 text-xs cursor-pointer"
        title="Playback speed"
      >
        {PLAYBACK_SPEEDS.map((s) => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
    </div>
  );
}

/** Faint dotted grid drawn behind tiles in edit mode. The CSS gradient stops
 *  draw a 1×1 dot at every grid intersection; spacing matches the
 *  GRID_COLS/GRID_ROWS used for snapping. */
function GridOverlay() {
  const cellW = `${100 / GRID_COLS}%`;
  const cellH = `${100 / GRID_ROWS}%`;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage:
          "radial-gradient(circle, #2A2C32 1px, transparent 1px)",
        backgroundSize: `${cellW} ${cellH}`,
      }}
    />
  );
}
