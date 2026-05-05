import { useEffect, useState } from "react";
import { CursorEmitter, formatClock } from "@helios/lib";
import { loadAllSessions } from "./lib/load-sample";
import type { LoadedSession } from "./lib/session";
import type { TileSpec, Workspace } from "./workspaces/types";
import { loadWorkspaces, saveWorkspaces, resetToBuiltins } from "./lib/workspace-storage";
import { findNextFreeSlot, snapAllToGrid, GRID_COLS, GRID_ROWS } from "./lib/grid";
import {
  type MathChannel, applyMathChannels, loadMathChannels, saveMathChannels,
} from "./lib/math-channels";
import { Tile } from "./components/Tile";
import { SessionPanel } from "./components/SessionPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { ChannelsModal } from "./components/ChannelsModal";
import { AddTileModal } from "./components/AddTileModal";
import { MathChannelsModal } from "./components/MathChannelsModal";

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

  useEffect(() => {
    loadAllSessions()
      .then((loaded) => {
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
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="p-8 text-[#EF5350]">{error}</div>;
  if (!sessions || !primaryId) return <div className="p-8 text-[#7B8088]">Loading sessions…</div>;

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

  function commitWorkspaces(next: Workspace[]) {
    saveWorkspaces(next);
    setWorkspaces(next);
  }

  function updateTile(nextTile: TileSpec) {
    commitWorkspaces(workspaces.map((w) => (w.id !== workspaceId
      ? w
      : { ...w, tiles: w.tiles.map((t) => (t.id === nextTile.id ? nextTile : t)) }
    )));
  }

  function deleteTile(tileId: string) {
    commitWorkspaces(workspaces.map((w) => (w.id !== workspaceId
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
    commitWorkspaces(workspaces.map((w) => (w.id !== workspaceId
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
    commitWorkspaces(workspaces.map((w) => (w.id !== workspaceId
      ? w
      : { ...w, tiles: [...w.tiles, tile] }
    )));
    setSelectedTileId(tile.id);
  }

  function handleSnapToGrid() {
    commitWorkspaces(workspaces.map((w) => (w.id !== workspaceId ? w : snapAllToGrid(w))));
  }

  function handleResetWorkspaces() {
    if (!confirm("Reset all workspaces to their built-in defaults? Unsaved edits will be lost.")) return;
    const fresh = resetToBuiltins();
    setWorkspaces(fresh);
    setSelectedTileId(null);
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
        <span className="text-[#FFC627] font-bold">HELIOS</span>
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
    </div>
  );
}

function CursorClock({ emitter }: { emitter: CursorEmitter }) {
  const [t, setT] = useState(emitter.get());
  useEffect(() => emitter.subscribe(setT), [emitter]);
  return <>{formatClock(t)}</>;
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
