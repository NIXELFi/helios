import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  CursorEmitter, ViewStateEmitter, LapSelectionEmitter, GpsPickerEmitter,
  detectLaps, formatClock,
} from "@helios/lib";
import type { LapDetectionConfig, LapSelection } from "@helios/lib";
import { loadAllSessions, type LoadProgress } from "./lib/load-sample";
import type { LoadedSession } from "./lib/session";
import { SESSION_PALETTE } from "./lib/session";
import { lapInputsFor, saveLapConfig } from "./lib/lap-config";
import type { TileSpec, Workspace } from "./workspaces/types";
import { loadWorkspaces, saveWorkspaces, resetToBuiltins } from "./lib/workspace-storage";
import { findNextFreeSlot, snapAllToGrid, GRID_COLS, GRID_ROWS } from "./lib/grid";
import {
  type MathChannel, applyMathChannels, loadMathChannels, saveMathChannels,
} from "./lib/math-channels";
import { serializeBundle, parseBundle, mergeImported, slugifyForFilename } from "./lib/workspace-bundle";
import { saveBundleFile, openBundleFile } from "./lib/workspace-dialog";
import { useUpdater } from "./lib/use-updater";
import { useFileOpener } from "./lib/use-file-opener";
import { formatFileOpenSummary } from "./lib/file-open-summary";
import type { PerFileResult } from "./lib/file-open-summary";
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
import { WorkspaceTabBar } from "./components/WorkspaceTabBar";
import { LapConfigDialog } from "./components/LapConfigDialog";

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
  const [viewState] = useState(() => new ViewStateEmitter());
  // Global Main/Ref/Overlay lap selection — drives multi-lap traces in
  // distance mode and the lap-panel selection chrome. Initialized to all
  // null; auto-populated to (best lap, second-best lap) once sessions land
  // so the user has a useful default without having to click anything.
  const [lapSelectionEmitter] = useState(() => new LapSelectionEmitter());
  const [lapSelection, setLapSelection] = useState<LapSelection>(lapSelectionEmitter.get());
  useEffect(() => lapSelectionEmitter.subscribe(setLapSelection), [lapSelectionEmitter]);
  // Picker for "click on the GPS track to pick a coordinate" flows. The Lap
  // Config dialog arms it; the GPS Track widget responds to clicks while armed.
  const [gpsPickerEmitter] = useState(() => new GpsPickerEmitter());

  const [editMode, setEditMode] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [addTileOpen, setAddTileOpen] = useState(false);
  const [mathChannelsOpen, setMathChannelsOpen] = useState(false);
  const [lapConfigSessionId, setLapConfigSessionId] = useState<string | null>(null);
  const [mathChannels, setMathChannelsState] = useState<MathChannel[]>(() => loadMathChannels());
  const [mathErrors, setMathErrors] = useState<Map<string, Map<string, string>>>(new Map());
  const updater = useUpdater();
  useFileOpener({ onPending: handleFileOpenPending });
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  type ConfirmRequest = {
    title: string;
    body: string | ReactNode;
    confirmLabel: string;
    confirmTone: "default" | "danger";
    cancelLabel?: string;
    onConfirm: () => void;
  };
  const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
  const [playing, setPlaying] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("dev");
  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
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
        const errors = new Map<string, Map<string, string>>();
        for (const session of loaded) {
          const r = applyMathChannels(session.store, initialMath, session.laps);
          errors.set(session.id, r.errors);
        }
        setMathErrors(errors);
        setSessions(loaded);
        const firstVisible = loaded.find((s) => s.visible) ?? loaded[0];
        setPrimaryId(firstVisible?.id ?? null);
        // Default lap selection: best lap of primary as Main, second-best as Ref.
        if (firstVisible?.laps && firstVisible.laps.bestLapIndex >= 0) {
          const set = firstVisible.laps;
          lapSelectionEmitter.setMain({ sessionId: firstVisible.id, lapIndex: set.bestLapIndex });
          // Pick the second-fastest trusted lap for Ref, if there is one.
          const trusted = set.laps
            .map((l, i) => ({ l, i }))
            .filter((x) => x.l.trusted && x.i !== set.bestLapIndex)
            .sort((a, b) => a.l.durationS - b.l.durationS);
          if (trusted.length > 0) {
            lapSelectionEmitter.setRef({ sessionId: firstVisible.id, lapIndex: trusted[0]!.i });
          }
        }
        setLoadProgress({
          label: "Ready",
          loaded: loaded.length + 1,
          total: loaded.length + 1,
        });
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const primaryMathErrors = mathErrors.get(primary.id) ?? new Map<string, string>();
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]!;
  const selectedTile = workspace.tiles.find((t) => t.id === selectedTileId) ?? null;
  const lapConfigSession = lapConfigSessionId
    ? sessions.find((s) => s.id === lapConfigSessionId) ?? null
    : null;

  function toggleVisibility(id: string) {
    setSessions((prev) => {
      if (!prev) return prev;
      const next = prev.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s));
      const stillVisible = next.find((s) => s.id === primaryId)?.visible;
      if (!stillVisible) {
        const fallback = next.find((s) => s.visible);
        if (fallback) setPrimaryId(fallback.id);
      }
      // Drop any lap selection pointing at sessions that just went invisible.
      const visibleIds = new Set(next.filter((s) => s.visible).map((s) => s.id));
      lapSelectionEmitter.prune(visibleIds);
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

  function handleCreateWorkspace() {
    const usedColors = new Set(workspaces.map((w) => w.color));
    const nextColor = SESSION_PALETTE.find((c) => !usedColors.has(c)) ?? SESSION_PALETTE[workspaces.length % SESSION_PALETTE.length]!;
    const taken = new Set(workspaces.map((w) => w.label));
    let n = 1;
    while (taken.has(`Workspace ${n}`)) n++;
    const fresh: Workspace = {
      id: crypto.randomUUID(),
      label: `Workspace ${n}`,
      color: nextColor,
      tiles: [],
    };
    commitWorkspaces((prev) => [...prev, fresh]);
    setWorkspaceId(fresh.id);
    setSelectedTileId(null);
  }

  function handleRenameWorkspace(id: string, label: string) {
    commitWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, label } : w)));
  }

  function handleRecolorWorkspace(id: string, color: string) {
    commitWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, color } : w)));
  }

  function handleDuplicateWorkspace(id: string) {
    const src = workspaces.find((w) => w.id === id);
    if (!src) return;
    const copy: Workspace = {
      ...JSON.parse(JSON.stringify(src)),
      id: crypto.randomUUID(),
      label: `${src.label} copy`,
    };
    commitWorkspaces((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      const next = [...prev];
      next.splice(i + 1, 0, copy);
      return next;
    });
    setWorkspaceId(copy.id);
    setSelectedTileId(null);
  }

  function handleRequestDeleteWorkspace(id: string) {
    if (workspaces.length <= 1) return;
    const target = workspaces.find((w) => w.id === id);
    if (!target) return;
    setConfirmState({
      title: `Delete workspace "${target.label}"?`,
      body: "This cannot be undone. Tiles in this workspace will be lost.",
      confirmLabel: "Delete",
      confirmTone: "danger",
      cancelLabel: "Cancel",
      onConfirm: () => {
        commitWorkspaces((prev) => prev.filter((w) => w.id !== id));
        if (workspaceId === id) {
          const remaining = workspaces.filter((w) => w.id !== id);
          const idx = workspaces.findIndex((w) => w.id === id);
          const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0]!;
          setWorkspaceId(next.id);
          setSelectedTileId(null);
        }
        setConfirmState(null);
      },
    });
  }

  function handleReorderWorkspaces(fromIndex: number, toIndex: number) {
    commitWorkspaces((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved!);
      return next;
    });
  }

  async function handleExportWorkspace(id: string) {
    const w = workspaces.find((x) => x.id === id);
    if (!w) return;
    const json = serializeBundle([w], appVersion);
    await saveBundleFile(`helios-workspace-${slugifyForFilename(w.label)}.helios`, json);
  }

  async function handleExportAllWorkspaces() {
    const json = serializeBundle(workspaces, appVersion);
    await saveBundleFile("helios-workspaces.helios", json);
  }

  async function handleImportWorkspaces() {
    const text = await openBundleFile();
    if (text === null) return;
    const result = parseBundle(text);
    if (!result.ok) {
      setConfirmState({
        title: "Could not import",
        body: result.reason,
        confirmLabel: "OK",
        confirmTone: "default",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }
    const firstImportedIndex = workspaces.length;
    const merged = mergeImported(workspaces, result.bundle.workspaces);
    commitWorkspaces(() => merged);
    setWorkspaceId(merged[firstImportedIndex]!.id);
    setSelectedTileId(null);
  }

  function handleFileOpenPending(perFile: PerFileResult[]) {
    const summary = formatFileOpenSummary(perFile);
    if (summary.isAlert) {
      setConfirmState({
        title: summary.title,
        body: <span style={{ whiteSpace: "pre-line" }}>{summary.body}</span>,
        confirmLabel: "OK",
        confirmTone: "default",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }
    const validBundles = perFile
      .filter((r): r is Extract<PerFileResult, { kind: "valid" }> => r.kind === "valid")
      .flatMap((r) => r.workspaces);
    setConfirmState({
      title: summary.title,
      body: <span style={{ whiteSpace: "pre-line" }}>{summary.body}</span>,
      confirmLabel: "Import",
      confirmTone: "default",
      cancelLabel: "Cancel",
      onConfirm: () => {
        let firstImportedId: string | null = null;
        commitWorkspaces((prev) => {
          const firstImportedIndex = prev.length;
          const merged = mergeImported(prev, validBundles);
          firstImportedId = merged[firstImportedIndex]!.id;
          return merged;
        });
        if (firstImportedId !== null) {
          setWorkspaceId(firstImportedId);
          setSelectedTileId(null);
        }
        setConfirmState(null);
      },
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
      title: "Reset all workspaces?",
      body: "Every workspace will be replaced by its built-in default. Unsaved edits will be lost.",
      confirmLabel: "Reset all",
      confirmTone: "danger",
      cancelLabel: "Cancel",
      onConfirm: () => {
        const fresh = resetToBuiltins();
        setWorkspaces(fresh);
        setSelectedTileId(null);
        setConfirmState(null);
      },
    });
  }

  /** Update the lap detection config for one session, recompute its laps,
   *  re-apply math channels (lap_* depends on the LapSet), and persist. */
  function handleLapConfigSave(sessionId: string, cfg: LapDetectionConfig) {
    setSessions((prev) => {
      if (!prev) return prev;
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s;
        const laps = cfg.mode === "none" ? null : detectLaps(cfg, lapInputsFor(s.store));
        return { ...s, lapConfig: cfg, laps };
      });
      // Re-apply math channels for the updated session so lap_* works.
      const target = next.find((s) => s.id === sessionId)!;
      // Math channels live as columns inside the rate group; remove the math
      // ids first so a stale lap_* output doesn't survive.
      for (const m of mathChannels) target.store.removeChannel(m.id);
      const r = applyMathChannels(target.store, mathChannels, target.laps);
      const newErrors = new Map(mathErrors);
      newErrors.set(sessionId, r.errors);
      setMathErrors(newErrors);
      return next;
    });
    saveLapConfig(sessionId, cfg);
    // Drop any current lap selection pointing into the session whose laps
    // just changed — the indices may no longer be valid.
    if (lapSelection.main?.sessionId === sessionId) lapSelectionEmitter.setMain(null);
    if (lapSelection.ref?.sessionId === sessionId) lapSelectionEmitter.setRef(null);
    if (lapSelection.overlays.some((r) => r.sessionId === sessionId)) {
      lapSelectionEmitter.set({
        ...lapSelection,
        overlays: lapSelection.overlays.filter((r) => r.sessionId !== sessionId),
      });
    }
  }

  /** Replace the math-channel set, persist, and re-apply against every loaded
   *  session. Old math-channel ids are removed from each store first so a
   *  rename/delete doesn't leave stale columns behind. */
  function handleMathChannelsChange(next: MathChannel[]) {
    setMathChannelsState(next);
    saveMathChannels(next);
    if (!sessions) return;
    const allOldIds = new Set([...mathChannels.map((m) => m.id), ...next.map((m) => m.id)]);
    const errors = new Map<string, Map<string, string>>();
    for (const session of sessions) {
      for (const id of allOldIds) session.store.removeChannel(id);
      const r = applyMathChannels(session.store, next, session.laps);
      errors.set(session.id, r.errors);
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
        {!editMode && (
          <>
            <span className="ml-3 text-[#7B8088]">{primary.label}</span>
            <div className="ml-3 self-stretch border-l border-[#2A2C32]" aria-hidden />
            <WorkspaceTabBar
              workspaces={workspaces}
              activeId={workspaceId}
              appVersion={appVersion}
              onSelect={(id) => { setWorkspaceId(id); setSelectedTileId(null); }}
              onCreate={handleCreateWorkspace}
              onRename={handleRenameWorkspace}
              onRecolor={handleRecolorWorkspace}
              onDuplicate={handleDuplicateWorkspace}
              onDelete={handleRequestDeleteWorkspace}
              onReorder={handleReorderWorkspaces}
              onExport={handleExportWorkspace}
              onExportAll={handleExportAllWorkspaces}
              onImport={handleImportWorkspaces}
            />
          </>
        )}
        <div className={
          "flex items-center gap-2 self-stretch " +
          (editMode ? "mx-auto" : "ml-3 pl-3 border-l border-[#2A2C32]")
        }>
          <ViewStatePills viewState={viewState} />
          <LapSelectionPill emitter={lapSelectionEmitter} sessions={sessions} />
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
              (primaryMathErrors.size > 0
                ? "bg-[#16171B] text-[#EF5350] border-[#EF5350]"
                : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
            }
            title={primaryMathErrors.size > 0
              ? `${primaryMathErrors.size} math channel(s) failed to compile`
              : "Define computed channels by formula"}
          >
            ƒ Math {mathChannels.length > 0 ? `(${mathChannels.length})` : ""}
          </button>
          <ExportMenuButton sessions={sessions} primary={primary} viewState={viewState} />
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
              >+ Add tile</button>
              <button
                onClick={handleSnapToGrid}
                className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
                title="Snap every tile's position and size to the grid; sizes are preserved"
              >Snap to grid</button>
              <button
                onClick={handleResetWorkspaces}
                className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#7B8088] hover:text-[#EF5350] hover:border-[#EF5350] rounded-sm cursor-pointer transition-colors"
                title="Reset every workspace to its built-in default"
              >Reset all</button>
            </>
          )}
          {!editMode && (
            <>
              <PlaybackControls emitter={emitter} viewState={viewState} ext={ext} playing={playing} onPlayingChange={setPlaying} />
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
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <SessionPanel
          sessions={sessions}
          primaryId={primary.id}
          onToggleVisibility={toggleVisibility}
          onSetPrimary={setPrimaryId}
          onConfigureLaps={(id) => setLapConfigSessionId(id)}
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
              viewState={viewState}
              lapSelectionEmitter={lapSelectionEmitter}
              lapSelection={lapSelection}
              gpsPickerEmitter={gpsPickerEmitter}
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
        {" · "}<FpsCounter />
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
          errors={primaryMathErrors}
          availableChannels={primary.store.list().filter((c) => c.source !== "math")}
          onChange={handleMathChannelsChange}
          onClose={() => setMathChannelsOpen(false)}
        />
      )}
      {lapConfigSession && (
        <LapConfigDialog
          session={lapConfigSession}
          gpsPickerEmitter={gpsPickerEmitter}
          onSave={(cfg) => handleLapConfigSave(lapConfigSession.id, cfg)}
          onClose={() => setLapConfigSessionId(null)}
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
          title={confirmState.title}
          body={confirmState.body}
          confirmLabel={confirmState.confirmLabel}
          confirmTone={confirmState.confirmTone}
          cancelLabel={confirmState.cancelLabel}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
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

function FpsCounter() {
  const [stats, setStats] = useState({ fps: 0, ms: 0 });
  useEffect(() => {
    let rafId: number;
    let frames = 0;
    let windowStart = performance.now();
    let lastFrame = windowStart;
    let maxDt = 0;
    const tick = (now: number) => {
      frames += 1;
      const dt = now - lastFrame;
      if (dt > maxDt) maxDt = dt;
      lastFrame = now;
      const elapsed = now - windowStart;
      if (elapsed >= 500) {
        setStats({ fps: Math.round((frames * 1000) / elapsed), ms: Math.round(maxDt) });
        frames = 0;
        windowStart = now;
        maxDt = 0;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);
  const color = stats.fps >= 55 ? "" : stats.fps >= 30 ? "text-[#FFC627]" : "text-[#EF5350]";
  return (
    <span
      className={`font-mono-num ${color}`}
      title={`Worst frame in the last 500 ms took ${stats.ms} ms (${stats.fps} fps average)`}
    >
      {stats.fps}fps/{stats.ms}ms
    </span>
  );
}

function ViewStatePills({ viewState }: { viewState: ViewStateEmitter }) {
  const [state, setState] = useState(viewState.get());
  useEffect(() => viewState.subscribe(setState), [viewState]);
  if (!state.zoomRange && state.datums.length === 0) return null;
  return (
    <>
      {state.zoomRange && (
        <button
          onClick={() => viewState.resetZoom()}
          className="px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold hover:brightness-110"
          title="Reset zoom to the full session range (or double-click any chart)"
        >
          Reset zoom
        </button>
      )}
      {state.datums.length > 0 && (
        <button
          onClick={() => viewState.clearDatums()}
          className="px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold hover:brightness-110"
          title="Remove all datum markers"
        >
          Clear datums ({state.datums.length})
        </button>
      )}
    </>
  );
}

/** Surfaces the active Main/Ref lap selection so the user can see at a glance
 *  which laps the distance-axis traces are showing, and clear with one click. */
function LapSelectionPill({ emitter, sessions }: { emitter: LapSelectionEmitter; sessions: LoadedSession[] }) {
  const [sel, setSel] = useState(emitter.get());
  useEffect(() => emitter.subscribe(setSel), [emitter]);
  if (!sel.main && !sel.ref && sel.overlays.length === 0) return null;
  function describe(ref: typeof sel.main): string {
    if (!ref) return "—";
    const s = sessions.find((x) => x.id === ref.sessionId);
    if (!s || !s.laps) return "—";
    const lap = s.laps.laps[ref.lapIndex];
    if (!lap) return "—";
    return `${s.label.split(" — ")[0] ?? s.label} L${lap.index}`;
  }
  return (
    <button
      onClick={() => emitter.set({ main: null, ref: null, overlays: [] })}
      className="px-2 py-0.5 text-xs border rounded-sm cursor-pointer bg-[#16171B] text-[#FFC627] border-[#FFC627] hover:brightness-110 font-mono-num"
      title="Clear lap selection (Main, Ref, Overlays)"
    >
      M:{describe(sel.main)}
      {sel.ref && <> · R:{describe(sel.ref)}</>}
      {sel.overlays.length > 0 && <> · +{sel.overlays.length}</>}
    </button>
  );
}

/** Compact menu — opens a small popover with CSV / KML export actions. */
function ExportMenuButton({ sessions, primary, viewState }: {
  sessions: LoadedSession[]; primary: LoadedSession; viewState: ViewStateEmitter;
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
  async function exportCsv(scope: "session" | "zoom") {
    const { exportSessionCsv } = await import("./lib/csv-export");
    const range = scope === "zoom" ? viewState.get().zoomRange : null;
    await exportSessionCsv(primary, range);
    setOpen(false);
  }
  async function exportKml() {
    const { exportSessionKml } = await import("./lib/kml-export");
    await exportSessionKml(primary);
    setOpen(false);
  }
  // Keep `sessions` referenced so React's exhaustive-deps lint stays quiet
  // even though we only consume the primary right now; multi-session export
  // is on the roadmap.
  void sessions;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Export"
      >Export ▾</button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-[#0E0E10] border border-[#2A2C32] z-30 text-xs">
          <button onClick={() => exportCsv("session")} className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]">CSV — primary session, full</button>
          <button onClick={() => exportCsv("zoom")} className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]">CSV — primary, zoom range</button>
          <button onClick={() => exportKml()} className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]">KML — GPS path (primary)</button>
        </div>
      )}
    </div>
  );
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

function PlaybackControls({
  emitter, viewState, ext, playing, onPlayingChange,
}: {
  emitter: CursorEmitter;
  viewState: ViewStateEmitter;
  ext: { startUs: number; endUs: number };
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
}) {
  const setPlaying = onPlayingChange;
  const [speed, setSpeed] = useState<number>(1);
  const speedRef = useRef(speed); speedRef.current = speed;
  const extRef = useRef(ext); extRef.current = ext;
  const viewStateRef = useRef(viewState); viewStateRef.current = viewState;

  const effectiveBounds = (): { startUs: number; endUs: number } => {
    const z = viewStateRef.current.get().zoomRange;
    return z ?? extRef.current;
  };

  useEffect(() => {
    if (!playing) return;
    let rafId: number;
    let wallStartMs = performance.now();
    let cursorStartUs = emitter.get();
    let lastWrittenUs = cursorStartUs;
    const b0 = effectiveBounds();
    if (cursorStartUs >= b0.endUs - 1000 || cursorStartUs < b0.startUs) {
      cursorStartUs = b0.startUs;
      emitter.emit(cursorStartUs);
      lastWrittenUs = cursorStartUs;
    }

    const tick = () => {
      const b = effectiveBounds();
      const currentUs = emitter.get();
      if (currentUs !== lastWrittenUs) {
        wallStartMs = performance.now();
        cursorStartUs = currentUs;
      }
      const wallElapsedMs = performance.now() - wallStartMs;
      let next = Math.round(cursorStartUs + wallElapsedMs * 1000 * speedRef.current);
      if (next >= b.endUs || next < b.startUs) {
        next = b.startUs;
        wallStartMs = performance.now();
        cursorStartUs = next;
      }
      emitter.emit(next);
      lastWrittenUs = next;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, emitter]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

