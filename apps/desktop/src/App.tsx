import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CursorEmitter, ViewStateEmitter, LapSelectionEmitter, GpsPickerEmitter,
  detectLaps, formatClock, formatLapTime,
} from "@helios/lib";
import type { LapDetectionConfig, LapSelection } from "@helios/lib";
import { loadAllSessions, type LoadProgress } from "./lib/load-sample";
import type { LoadedSession } from "./lib/session";
import { SESSION_PALETTE, colorForIndex } from "./lib/session";
import { lapInputsFor, saveLapConfig } from "./lib/lap-config";
import { saveChannelOverrides } from "./lib/channel-overrides";
import { classifyPaths, loadUserSession } from "./lib/load-user-session";
import { useFileDrop } from "./lib/use-file-drop";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { TileSpec, Workspace } from "./workspaces/types";
import { loadWorkspaces, saveWorkspaces, resetToBuiltins } from "./lib/workspace-storage";
import {
  loadLastWorkspaceId, saveLastWorkspaceId,
  loadRecentSessions, addRecentSession, removeRecentSession,
  loadViewStateFor, saveViewStateFor,
  loadLapSelection, saveLapSelection,
} from "./lib/app-state";
import { findNextFreeSlot, snapAllToGrid, GRID_COLS, GRID_ROWS } from "./lib/grid";
import { stepToLapBoundary } from "./lib/lap-step";
import { progressFraction } from "./lib/load-progress";
import {
  type MathChannel, applyMathChannels, loadMathChannels, saveMathChannels,
} from "./lib/math-channels";
import { serializeBundle, parseBundle, mergeImported, slugifyForFilename } from "./lib/workspace-bundle";
import { saveBundleFile, openBundleFile } from "./lib/workspace-dialog";
import { useFileOpener } from "./lib/use-file-opener";
import { formatFileOpenSummary } from "./lib/file-open-summary";
import type { PerFileResult } from "./lib/file-open-summary";
import { Tile } from "./components/Tile";
import { SessionPanel } from "./components/SessionPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { ChannelsModal } from "./components/ChannelsModal";
import { AddTileModal } from "./components/AddTileModal";
import { MathChannelsModal } from "./components/MathChannelsModal";
import { LoadingScreen } from "./components/LoadingScreen";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { WorkspaceTabBar } from "./components/WorkspaceTabBar";
import { LapConfigDialog } from "./components/LapConfigDialog";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { HelpModal } from "./help/HelpModal";

export interface LogsAppProps {
  /** Current app version — used to stamp exported workspace bundles. The
   *  Shell owns the live `getVersion()` call so the wordmark + version in
   *  the sidebar persists across modules. */
  appVersion: string;
  /** Lifted to the Shell so the UpdateModal can disable "Install and restart"
   *  mid-playback even when the user is currently viewing Vault or CFD. */
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
}

export default function App({ appVersion, playing, onPlayingChange }: LogsAppProps) {
  // Load workspaces from storage exactly once at boot. Previously both
  // useState initializers below called loadWorkspaces() independently, which
  // re-ran the side-effecting schema migrations twice. We derive both the
  // workspaces array and the initial active id from this single result.
  const bootRef = useRef<{ workspaces: Workspace[]; activeId: string } | null>(null);
  if (bootRef.current === null) {
    const list = loadWorkspaces();
    const saved = loadLastWorkspaceId();
    // Restore the last active workspace if it still exists; otherwise fall
    // back to the first workspace so a stale id doesn't strand the user on
    // a blank header.
    const activeId = saved && list.some((w) => w.id === saved)
      ? saved
      : list[0]?.id ?? "overview";
    bootRef.current = { workspaces: list, activeId };
  }
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => bootRef.current!.workspaces);
  const [workspaceId, setWorkspaceIdRaw] = useState(() => bootRef.current!.activeId);
  // Wrap setWorkspaceId to persist the choice. Every call site (tab click,
  // import, duplicate, new) flows through this so we never miss a write.
  const setWorkspaceId = (id: string) => {
    setWorkspaceIdRaw(id);
    saveLastWorkspaceId(id);
  };
  const [sessions, setSessions] = useState<LoadedSession[] | null>(null);
  // Mirror sessions/primaryId/mathChannels into refs so async handlers (file
  // open, lap-config save) can read the LATEST committed values at apply time
  // instead of whatever was captured in their closure when the handler ran.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const primaryIdRef = useRef(primaryId);
  primaryIdRef.current = primaryId;
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [helpState, setHelpState] = useState<{ open: boolean; slug?: string }>({ open: false });
  const openHelp = (slug?: string) => setHelpState({ open: true, slug });
  const closeHelp = () => setHelpState({ open: false });
  const [mathChannels, setMathChannelsState] = useState<MathChannel[]>(() => loadMathChannels());
  const mathChannelsRef = useRef(mathChannels);
  mathChannelsRef.current = mathChannels;
  const [mathErrors, setMathErrors] = useState<Map<string, Map<string, string>>>(new Map());
  useFileOpener({ onPending: handleFileOpenPending });
  // OS-level drag-drop of data files (CSV) onto the app window. .helios
  // workspace bundles are routed away from this hook (they belong to the
  // useFileOpener path above). Fires for any drop over the webview, so the
  // user doesn't have to aim at the sessions panel specifically.
  useFileDrop({ onDrop: (paths) => void handleAddSessionFiles(paths) });
  type ConfirmRequest = {
    title: string;
    body: string | ReactNode;
    confirmLabel: string;
    confirmTone: "default" | "danger";
    cancelLabel?: string;
    onConfirm: () => void;
  };
  const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({
    label: "Starting…", loaded: 0, total: 1,
  });
  // Highest progress fraction shown so far — keeps the loading bar monotonic
  // across boot stages whose denominators differ (see lib/load-progress).
  const progressFloorRef = useRef(0);

  useEffect(() => {
    loadAllSessions((p) => setLoadProgress(p))
      .then(async (bundled) => {
        // Silently re-load recent user sessions before the first paint. Files
        // that no longer exist (deleted, moved off a removable drive) are
        // dropped from the recents list and never bother the user with a
        // popup — they came from days-ago activity, not the current intent.
        const recents = loadRecentSessions();
        // One monotonic total for every post-load stage: each recent file is a
        // step, plus a "compute math" step and a final "ready" step. The bar's
        // monotonic floor (progressFraction) guards the boundary against the
        // bundled-only denominator used during the loadAllSessions phase.
        const total = bundled.length + recents.length + 2;
        const userLoaded: LoadedSession[] = [];
        let colorIdx = bundled.length;
        for (let i = 0; i < recents.length; i++) {
          const path = recents[i]!;
          setLoadProgress({
            label: `Re-opening ${path.split(/[\\/]/).pop() ?? path}`,
            loaded: bundled.length + i,
            total,
          });
          try {
            const session = await loadUserSession(path, colorForIndex(colorIdx));
            colorIdx++;
            userLoaded.push(session);
          } catch {
            removeRecentSession(path);
          }
        }
        const loaded = [...bundled, ...userLoaded];
        setLoadProgress({
          label: "Computing math channels",
          loaded: bundled.length + recents.length,
          total,
        });
        // Everything from here through the lap-restore is best-effort: a single
        // bad bundled math formula or a malformed saved lap selection must NOT
        // strand the user on a blank loading screen. We commit whatever
        // sessions loaded no matter what, then attempt the niceties.
        const firstVisible = loaded.find((s) => s.visible) ?? loaded[0];
        try {
          const initialMath = loadMathChannels();
          const errors = new Map<string, Map<string, string>>();
          for (const session of loaded) {
            try {
              const r = applyMathChannels(session.store, initialMath, session.laps);
              errors.set(session.id, r.errors);
            } catch (mathErr) {
              // Surface as a per-session compile error rather than aborting boot.
              errors.set(session.id, new Map([["*", String(mathErr)]]));
            }
          }
          setMathErrors(errors);
        } catch (mathErr) {
          // loadMathChannels itself failed (corrupt blob) — boot without math.
          console.error("Math channel init failed during boot:", mathErr);
        }
        // Commit the loaded sessions BEFORE the lap-restore so any throw below
        // can't prevent the app from leaving the loading screen.
        setSessions(loaded);
        setPrimaryId(firstVisible?.id ?? null);
        try {
          // Restore the user's last manual lap selection if any of its refs
          // still point at a valid (loaded session, in-range lap). Falls back
          // to the auto-pick (best/2nd-best on the primary) only when there's
          // nothing to restore — i.e. the user never explicitly picked, or
          // every saved ref points at a session that's no longer loaded.
          const saved = loadLapSelection();
          const validRef = (r: { sessionId: string; lapIndex: number } | null) => {
            if (!r) return null;
            const s = loaded.find((x) => x.id === r.sessionId);
            if (!s?.laps) return null;
            if (r.lapIndex < 0 || r.lapIndex >= s.laps.laps.length) return null;
            return r;
          };
          const restoredMain = saved ? validRef(saved.main) : null;
          const restoredRef  = saved ? validRef(saved.ref)  : null;
          const restoredOverlays = saved
            ? saved.overlays.map(validRef).filter((r): r is { sessionId: string; lapIndex: number } => r !== null)
            : [];
          if (restoredMain || restoredRef || restoredOverlays.length > 0) {
            lapSelectionEmitter.set({
              main: restoredMain,
              ref: restoredRef,
              overlays: restoredOverlays,
            });
          } else if (firstVisible?.laps && firstVisible.laps.bestLapIndex >= 0) {
            const set = firstVisible.laps;
            lapSelectionEmitter.setMain({ sessionId: firstVisible.id, lapIndex: set.bestLapIndex });
            const trusted = set.laps
              .map((l, i) => ({ l, i }))
              .filter((x) => x.l.trusted && x.i !== set.bestLapIndex)
              .sort((a, b) => a.l.durationS - b.l.durationS);
            if (trusted.length > 0) {
              lapSelectionEmitter.setRef({ sessionId: firstVisible.id, lapIndex: trusted[0]!.i });
            }
          }
        } catch (lapErr) {
          console.error("Lap-selection restore failed during boot:", lapErr);
        }
        setLoadProgress({ label: "Ready", loaded: total, total });
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts. Universal hotkeys (⌘K) fire from anywhere;
  // single-key shortcuts ([ ] etc.) skip text inputs so typing still works.
  // The hotkey set deliberately mirrors a subset of MoTeC i2 / Catalyst —
  // a user coming from those tools should feel at home.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Treat rich-text / contentEditable surfaces (e.g. a note field) as text
      // input too, so single-key shortcuts don't fire while the user is typing
      // into them. Ignore auto-repeat: holding a key shouldn't spam toggles.
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        target?.isContentEditable === true;
      if (e.repeat) return;

      // ⌘K — toggle command palette (works from anywhere).
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // ⌘1..9 — jump to workspace by index.
      if (mod && /^[1-9]$/.test(e.key) && !inField) {
        const idx = parseInt(e.key, 10) - 1;
        const target = workspaces[idx];
        if (target) {
          e.preventDefault();
          setWorkspaceId(target.id);
          setSelectedTileId(null);
        }
        return;
      }
      // ⌘E — toggle edit mode.
      if (mod && e.key.toLowerCase() === "e" && !inField) {
        e.preventDefault();
        setEditMode((v) => !v);
        return;
      }
      // ⌘O — open file dialog. The OS-level "open recent" stays available
      // via the system menu; this is just the fast keyboard route to add a
      // session without picking it from the sidebar.
      if (mod && e.key.toLowerCase() === "o" && !inField) {
        e.preventDefault();
        void handleAddSessionDialog();
        return;
      }
      // ? — show keyboard shortcuts overlay. No modifier; works from
      // anywhere outside a text input (typing ? into a search field should
      // type the character, not summon a dialog).
      if (e.key === "?" && !inField && !mod) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // F1 — open the in-app Help & Wiki. Universal (works from form fields
      // too) since it never interferes with text input.
      if (e.key === "F1") {
        e.preventDefault();
        openHelp();
        return;
      }
      // M / R — single-key lap assignment. Finds the lap containing the
      // current cursor on the primary session and sets it as Main (M) or
      // Ref (R). Power-user shortcut for the M/R/O buttons in the Sessions
      // panel; mirrors MoTeC's lap-pinning workflow.
      if ((e.key === "m" || e.key === "M") && !inField && !mod) {
        const p = sessions?.find((s) => s.id === primaryId);
        if (!p?.laps) return;
        const cur = emitter.get();
        const idx = p.laps.laps.findIndex((l) => cur >= l.startUs && cur <= l.endUs);
        if (idx >= 0) {
          e.preventDefault();
          lapSelectionEmitter.setMain({ sessionId: p.id, lapIndex: idx });
        }
        return;
      }
      if ((e.key === "r" || e.key === "R") && !inField && !mod) {
        const p = sessions?.find((s) => s.id === primaryId);
        if (!p?.laps) return;
        const cur = emitter.get();
        const idx = p.laps.laps.findIndex((l) => cur >= l.startUs && cur <= l.endUs);
        if (idx >= 0) {
          e.preventDefault();
          lapSelectionEmitter.setRef({ sessionId: p.id, lapIndex: idx });
        }
        return;
      }
      // [ / ] — step cursor to previous/next lap boundary on the primary.
      // The step logic (epsilon handling so it isn't sticky on a boundary,
      // clamping `[` to the session start) lives in stepToLapBoundary so it's
      // unit-tested independently of the keyboard plumbing.
      if ((e.key === "[" || e.key === "]") && !inField && !mod && !e.shiftKey) {
        const p = sessions?.find((s) => s.id === primaryId);
        if (!p?.laps || p.laps.laps.length === 0) return;
        e.preventDefault();
        const cur = emitter.get();
        const boundaries = p.laps.laps.map((l) => l.startUs);
        const target = stepToLapBoundary(
          boundaries,
          p.store.extentUs().startUs,
          cur,
          e.key === "]" ? "next" : "prev",
        );
        if (target !== null) emitter.emit(target);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, sessions, primaryId, emitter]);

  // Restore cursor + zoom whenever the primary session changes (including on
  // first boot). Cursor is clamped to the current session's extent so a saved
  // value that no longer fits the data is silently dropped to the closest edge.
  // We guard with a ref to ensure we only restore once per *real* primary
  // transition — React can call this effect with the same primaryId during
  // unrelated state churn, and re-emitting cursor on every churn would yank
  // the user out of wherever they're currently scrubbing.
  const lastRestoredPrimaryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessions || !primaryId) return;
    if (lastRestoredPrimaryRef.current === primaryId) return;
    lastRestoredPrimaryRef.current = primaryId;
    const snap = loadViewStateFor(primaryId);
    if (!snap) return;
    const primary = sessions.find((s) => s.id === primaryId);
    if (!primary) return;
    const ext = primary.store.extentUs();
    const cur = Math.max(ext.startUs, Math.min(ext.endUs, snap.cursorUs));
    emitter.emit(cur);
    if (snap.zoomRange) {
      const a = Math.max(ext.startUs, snap.zoomRange.startUs);
      const b = Math.min(ext.endUs, snap.zoomRange.endUs);
      if (b > a) viewState.setZoom({ startUs: a, endUs: b });
    }
    // Restore datums (vertical markers). Clamped to the session's extent so
    // a marker dropped at a moment that no longer exists silently drops.
    if (snap.datums && snap.datums.length > 0) {
      viewState.clearDatums();
      for (const d of snap.datums) {
        if (d >= ext.startUs && d <= ext.endUs) viewState.addDatum(d);
      }
    }
  }, [primaryId, sessions, emitter, viewState]);

  // Save cursor + zoom + datums under the current primary id whenever they
  // change, debounced 500ms so a 60Hz scrub doesn't write localStorage 60
  // times a second. Each new primary gets its own debounce window. Switching
  // primary (or unmounting) FLUSHES any pending write first, so unsaved datums
  // / zoom / cursor for the outgoing primary aren't dropped on the floor —
  // this effect's `primaryId` closure still points at the OLD id during its
  // cleanup, so the flush lands under the correct key.
  useEffect(() => {
    if (!primaryId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    const write = () => {
      const vs = viewState.get();
      saveViewStateFor(primaryId, {
        cursorUs: emitter.get(),
        zoomRange: vs.zoomRange,
        datums: vs.datums.length > 0 ? vs.datums.slice() : undefined,
      });
      pending = false;
    };
    const schedule = () => {
      pending = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, 500);
    };
    const offCursor = emitter.subscribe(schedule);
    const offView = viewState.subscribe(schedule);
    return () => {
      offCursor(); offView();
      if (timer !== null) clearTimeout(timer);
      // Flush a pending debounced write synchronously so a primary switch
      // mid-debounce persists the outgoing view-state instead of losing it.
      if (pending) write();
    };
  }, [primaryId, emitter, viewState]);

  // Persist the global lap selection on every change so user-driven Main/Ref
  // overrides survive restart. Debounced so rapid clicks through laps don't
  // hammer localStorage. The restore happens in the boot useEffect above.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = lapSelectionEmitter.subscribe((s) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => saveLapSelection(s), 400);
    });
    return () => { off(); if (timer !== null) clearTimeout(timer); };
  }, [lapSelectionEmitter]);

  if (error || !sessions || !primaryId) {
    // Clamp to [0,1] and never let the bar slide backward as the denominator
    // changes between boot stages.
    const fraction = progressFraction(loadProgress, progressFloorRef.current);
    progressFloorRef.current = fraction;
    return (
      <LoadingScreen
        progress={fraction}
        stage={loadProgress.label}
        error={error}
        version={appVersion}
      />
    );
  }

  const visibleSessions = sessions.filter((s) => s.visible);
  const primary = sessions.find((s) => s.id === primaryId) ?? visibleSessions[0] ?? sessions[0]!;
  const ext = primary.store.extentUs();
  const primaryMathErrors = mathErrors.get(primary.id) ?? new Map<string, string>();

  // Build the command-palette action list from current state. Re-derived
  // every render — cheap, and avoids stale-closure subtleties.
  const paletteActions: PaletteAction[] = [];
  workspaces.forEach((w, i) => {
    paletteActions.push({
      id: `ws:${w.id}`,
      label: `Switch to ${w.label}`,
      sublabel: w.id === workspaceId ? "(current)" : undefined,
      kind: "workspace",
      hint: i < 9 ? `⌘${i + 1}` : undefined,
      keywords: [w.id, "workspace", "tab"],
      run: () => { setWorkspaceId(w.id); setSelectedTileId(null); },
    });
  });
  sessions.forEach((s) => {
    paletteActions.push({
      id: `ses:${s.id}`,
      label: `Set primary: ${s.label}`,
      sublabel: s.id === primaryId ? "(current)" : undefined,
      kind: "session",
      keywords: [s.id, "primary", "session"],
      run: () => setPrimaryId(s.id),
    });
  });
  paletteActions.push(
    { id: "sys:channels", label: "Open Channels", kind: "system", keywords: ["inspect", "data"], run: () => setChannelsOpen(true) },
    { id: "sys:math",     label: "Open Math channels", kind: "system", keywords: ["formula", "expression"], run: () => setMathChannelsOpen(true) },
    { id: "sys:add-tile", label: "Add tile…", kind: "system", run: () => { if (!editMode) setEditMode(true); setAddTileOpen(true); } },
    { id: "sys:edit",     label: editMode ? "Exit edit mode" : "Enter edit mode", kind: "system", hint: "⌘E", run: () => setEditMode((e) => !e) },
    { id: "sys:shortcuts", label: "Keyboard shortcuts", kind: "system", hint: "?", keywords: ["help", "hotkeys"], run: () => setShortcutsOpen(true) },
    { id: "sys:help",      label: "Open Help & Wiki",   kind: "system", hint: "F1", keywords: ["docs", "guide", "manual", "wiki"], run: () => openHelp() },
    { id: "sys:help-getting-started", label: "Help: Getting started",    kind: "system", keywords: ["docs", "onboarding"], run: () => openHelp("01-getting-started") },
    { id: "sys:help-widgets",         label: "Help: Widgets reference",  kind: "system", keywords: ["docs", "widget"],      run: () => openHelp("04-widgets-reference") },
    { id: "sys:help-channels",        label: "Help: Channels & data",    kind: "system", keywords: ["docs", "csv"],         run: () => openHelp("05-channels-and-data") },
    { id: "sys:help-math",            label: "Help: Math channels",      kind: "system", keywords: ["docs", "formula"],     run: () => openHelp("06-math-channels") },
    { id: "sys:help-laps",            label: "Help: Laps & analysis",    kind: "system", keywords: ["docs", "lap"],         run: () => openHelp("07-laps-and-analysis") },
    { id: "sys:help-keyboard",        label: "Help: Keyboard & commands",kind: "system", keywords: ["docs", "hotkey"],      run: () => openHelp("08-keyboard-and-commands") },
    { id: "sys:reset-zoom", label: "Reset zoom", kind: "system", run: () => viewState.resetZoom() },
    { id: "sys:clear-datums", label: "Clear datums", kind: "system", run: () => viewState.clearDatums() },
    {
      id: "sys:drop-datum",
      label: "Drop datum at current cursor",
      sublabel: "Same as shift-click on a strip chart",
      kind: "system",
      keywords: ["mark", "annotate", "datum"],
      run: () => viewState.addDatum(emitter.get()),
    },
    {
      id: "sys:zoom-to-lap",
      label: "Zoom to current lap",
      sublabel: "Fit chart x-range to the lap containing the cursor",
      kind: "system",
      keywords: ["fit", "lap", "zoom"],
      run: () => {
        const cur = emitter.get();
        const ls = primary.laps;
        if (!ls) return;
        const lap = ls.laps.find((l) => cur >= l.startUs && cur <= l.endUs);
        if (lap) viewState.setZoom({ startUs: lap.startUs, endUs: lap.endUs });
      },
    },
  );
  // Lap-selection helpers. The user can also drive these from the Lap Panel,
  // but ⌘K → "main" → enter is the fastest way to retarget the Δt and any
  // distance-mode strip-chart on the current workspace.
  if (primary.laps && primary.laps.laps.length > 0) {
    const set = primary.laps;
    const trustedSorted = set.laps
      .map((l, i) => ({ l, i }))
      .filter((x) => x.l.trusted)
      .sort((a, b) => a.l.durationS - b.l.durationS);
    const best = trustedSorted[0];
    const second = trustedSorted[1];
    if (best) {
      paletteActions.push({
        id: "lap:best-main",
        label: `Set best lap as Main`,
        sublabel: `lap ${best.l.index} · ${best.l.durationS.toFixed(2)}s`,
        kind: "lap",
        keywords: ["main", "best", "fastest"],
        run: () => lapSelectionEmitter.setMain({ sessionId: primary.id, lapIndex: best.i }),
      });
    }
    if (second) {
      paletteActions.push({
        id: "lap:second-ref",
        label: `Set 2nd-best lap as Ref`,
        sublabel: `lap ${second.l.index} · ${second.l.durationS.toFixed(2)}s`,
        kind: "lap",
        keywords: ["ref", "reference", "compare"],
        run: () => lapSelectionEmitter.setRef({ sessionId: primary.id, lapIndex: second.i }),
      });
    }
    if (lapSelection.main && lapSelection.ref) {
      paletteActions.push({
        id: "lap:swap-main-ref",
        label: "Swap Main and Ref",
        kind: "lap",
        keywords: ["compare", "flip", "reverse"],
        run: () => {
          const m = lapSelection.main!;
          const r = lapSelection.ref!;
          lapSelectionEmitter.setMain(r);
          lapSelectionEmitter.setRef(m);
        },
      });
    }
    if (lapSelection.ref) {
      paletteActions.push({
        id: "lap:clear-ref",
        label: "Clear Ref lap (hide Δt)",
        kind: "lap",
        keywords: ["delta", "clear", "remove"],
        run: () => lapSelectionEmitter.setRef(null),
      });
    }
    // Per-lap "Set as Main/Ref" actions. Surfaced for every trusted lap so the
    // user can ⌘K → "lap 5 main" → Enter without leaving the keyboard.
    // Capped to a sane number to keep the palette responsive on endurance
    // sessions with hundreds of laps.
    const MAX_PER_LAP = 30;
    let lapActionCount = 0;
    for (let i = 0; i < set.laps.length && lapActionCount < MAX_PER_LAP; i++) {
      const lap = set.laps[i]!;
      if (!lap.trusted) continue;
      const lapNum = lap.index;
      paletteActions.push({
        id: `lap:${i}-main`,
        label: `Set lap ${lapNum} as Main`,
        sublabel: `${lap.durationS.toFixed(2)}s${i === set.bestLapIndex ? " · best" : ""}`,
        kind: "lap",
        keywords: ["main", `lap ${lapNum}`, String(lapNum)],
        run: () => lapSelectionEmitter.setMain({ sessionId: primary.id, lapIndex: i }),
      });
      paletteActions.push({
        id: `lap:${i}-ref`,
        label: `Set lap ${lapNum} as Ref`,
        sublabel: `${lap.durationS.toFixed(2)}s`,
        kind: "lap",
        keywords: ["ref", "reference", `lap ${lapNum}`, String(lapNum)],
        run: () => lapSelectionEmitter.setRef({ sessionId: primary.id, lapIndex: i }),
      });
      lapActionCount++;
    }
  }
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
      id: safeUUID(),
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
      id: safeUUID(),
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
        // Compute the next-active workspace from the LATEST list inside the
        // updater (not a stale closure snapshot of `workspaces`), so a delete
        // that races with another workspace mutation can't pick a wrong/gone id.
        let nextActiveId: string | null = null;
        commitWorkspaces((prev) => {
          const idx = prev.findIndex((w) => w.id === id);
          const remaining = prev.filter((w) => w.id !== id);
          if (prev.some((w) => w.id === id) && remaining.length > 0) {
            const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0]!;
            nextActiveId = next.id;
          }
          return remaining;
        });
        if (workspaceId === id && nextActiveId !== null) {
          setWorkspaceId(nextActiveId);
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
    // An empty bundle merges to no new workspaces — guard the index so we don't
    // crash dereferencing a non-existent entry. Just keep the current tab.
    const firstImported = merged[firstImportedIndex];
    if (firstImported) {
      setWorkspaceId(firstImported.id);
      setSelectedTileId(null);
    }
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
          // Guard the index: an empty bundle adds nothing, so the entry at
          // firstImportedIndex is undefined — don't crash on `.id`.
          firstImportedId = merged[firstImportedIndex]?.id ?? null;
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
    // Use cell-rounded dimensions ONLY to find a free position; the copy keeps
    // the original's exact fractional size so duplicating never silently
    // resizes a carefully-sized tile.
    const slot = findNextFreeSlot(
      workspace.tiles,
      Math.max(2, Math.round(orig.w * GRID_COLS)),
      Math.max(2, Math.round(orig.h * GRID_ROWS)),
    );
    const dupe: TileSpec = { ...orig, id: newId, x: slot.x, y: slot.y };
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

  /** Add one or more user-supplied data files as new sessions. Each file
   *  becomes its own LoadedSession with auto-detected laps and the same
   *  math channels applied. Failures surface in a single ConfirmDialog
   *  rather than per-file dialogs so a 5-file drop doesn't queue 5 modals. */
  async function handleAddSessionFiles(paths: string[]) {
    if (!sessionsRef.current) return;
    const { accepted, rejected } = classifyPaths(paths);
    const failures: { path: string; reason: string }[] = rejected.slice();
    const newSessions: LoadedSession[] = [];
    // Collect the next color slot up-front so all newly-added sessions get
    // distinct colors regardless of how many failures land in between. Read
    // the LATEST session count via the ref (the closure-captured `sessions`
    // could be stale if a previous drop is still in flight).
    let nextIndex = sessionsRef.current.length;
    for (const a of accepted) {
      try {
        const color = colorForIndex(nextIndex);
        nextIndex++;
        const session = await loadUserSession(a.path, color);
        // Apply the math channels as of now (ref), not as captured at call time.
        const r = applyMathChannels(session.store, mathChannelsRef.current, session.laps);
        const errorsForSession = r.errors;
        // Replace any pre-existing session with the same id (re-loading the
        // same file should refresh, not duplicate).
        newSessions.push(session);
        // Promote this path to the head of the recent-sessions list so it
        // silently re-opens on next launch.
        addRecentSession(a.path);
        // Stash math errors for the new session id.
        setMathErrors((prev) => {
          const next = new Map(prev);
          next.set(session.id, errorsForSession);
          return next;
        });
      } catch (e) {
        failures.push({ path: a.path, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    if (newSessions.length > 0) {
      setSessions((prev) => {
        if (!prev) return prev;
        const idMap = new Map<string, LoadedSession>();
        for (const s of prev) idMap.set(s.id, s);
        for (const ns of newSessions) idMap.set(ns.id, ns);
        return Array.from(idMap.values());
      });
    }
    if (failures.length > 0) {
      const lines = failures.map((f) => `${basenameOf(f.path)}: ${f.reason}`).join("\n");
      setConfirmState({
        title: failures.length === paths.length ? "Could not load file(s)" : "Some files failed to load",
        body: <span style={{ whiteSpace: "pre-line" }}>{lines}</span>,
        confirmLabel: "OK",
        confirmTone: "default",
        onConfirm: () => setConfirmState(null),
      });
    }
  }

  function handleRemoveSession(sessionId: string) {
    const target = sessions?.find((s) => s.id === sessionId);
    if (!target) return;
    setConfirmState({
      title: `Remove session "${target.label}"?`,
      body: target.id.startsWith("user:")
        ? "The file stays on disk; it just leaves this Helios session. Re-add it any time."
        : "This is a bundled sample — it will reappear on next launch.",
      confirmLabel: "Remove",
      confirmTone: "danger",
      cancelLabel: "Cancel",
      onConfirm: () => {
        // Compute the post-removal session list and the primary fallback from
        // the LATEST committed state (ref), OUTSIDE the updater — so the
        // setSessions updater stays pure (no nested setState, no stale reads).
        const current = sessionsRef.current ?? [];
        const remaining = current.filter((s) => s.id !== sessionId);
        setSessions(() => remaining);
        // Promote the first remaining visible session as primary if we just
        // dropped the current primary.
        if (sessionId === primaryIdRef.current) {
          const fallback = remaining.find((s) => s.visible) ?? remaining[0];
          setPrimaryId(fallback?.id ?? null);
        }
        // Drop math errors and lap selections that point at the removed session.
        setMathErrors((prev) => {
          const next = new Map(prev);
          next.delete(sessionId);
          return next;
        });
        const validIds = new Set(remaining.map((s) => s.id));
        lapSelectionEmitter.prune(validIds);
        // If this was a user-opened file, take it off the silent re-load list
        // so removal feels durable across restarts.
        if (target.sourcePath) removeRecentSession(target.sourcePath);
        setConfirmState(null);
      },
    });
  }

  async function handleAddSessionDialog() {
    const result = await openFileDialog({
      multiple: true,
      filters: [{ name: "Data files", extensions: ["csv"] }],
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    void handleAddSessionFiles(paths);
  }

  /** Update the lap detection config for one session, recompute its laps,
   *  re-apply math channels (lap_* depends on the LapSet), and persist. */
  function handleLapConfigSave(sessionId: string, cfg: LapDetectionConfig) {
    const current = sessionsRef.current;
    if (!current) return;
    const math = mathChannelsRef.current;
    // Compute everything (laps + store mutation + math errors) OUTSIDE the
    // setState updaters so each updater stays pure and the store mutation runs
    // exactly once (a setState updater can be invoked twice under StrictMode).
    const next = current.map((s) => {
      if (s.id !== sessionId) return s;
      const laps = cfg.mode === "none" ? null : detectLaps(cfg, lapInputsFor(s.store));
      return { ...s, lapConfig: cfg, laps };
    });
    const target = next.find((s) => s.id === sessionId)!;
    // Math channels live as columns inside the rate group; remove the math
    // ids first so a stale lap_* output doesn't survive.
    for (const m of math) target.store.removeChannel(m.id);
    const r = applyMathChannels(target.store, math, target.laps);
    setSessions(() => next);
    setMathErrors((prev) => {
      const updated = new Map(prev);
      updated.set(sessionId, r.errors);
      return updated;
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

  /** Bind a canonical channel id to a different source CSV column for a single
   *  session (or pass `null` for sourceHeader to reset to auto). Mutates the
   *  session's ChannelStore directly so existing widgets pick up the new
   *  routing on next paint, and persists to localStorage so the override
   *  survives app restart. */
  function handleChannelOverrideChange(
    sessionId: string,
    canonicalId: string,
    sourceHeader: string | null,
  ) {
    setSessions((prev) => {
      if (!prev) return prev;
      let saved: Record<string, string> | null = null;
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s;
        const overrides = { ...s.channelOverrides };
        if (sourceHeader === null) {
          delete overrides[canonicalId];
          s.store.clearChannelOverride(canonicalId);
        } else {
          overrides[canonicalId] = sourceHeader;
          s.store.setChannelOverride(canonicalId, sourceHeader);
        }
        saved = overrides;
        return { ...s, channelOverrides: overrides };
      });
      if (saved) saveChannelOverrides(sessionId, saved);
      return next;
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
      {/* Header doubles as the macOS drag region under titleBarStyle: Overlay.
          No extra left padding needed here: the 176px-wide ModulePicker rail
          sits to the left of this header in the Shell layout, so the inset
          traffic lights (positioned at 14,14 in tauri.conf.json) overlap
          ONLY the ModulePicker — which handles its own top clearance. The
          HELIOS wordmark used to live here too; it moved into the sidebar
          so brand chrome persists across Log / Vault / CFD. */}
      <header
        data-tauri-drag-region
        className="h-10 flex items-center px-3 border-b border-[#2A2C32] text-xs"
      >
        {!editMode && (
          <>
            <span className="text-[#9097A0] truncate max-w-[160px] flex-shrink-0" title={primary.label}>{primary.label}</span>
            <div className="ml-3 self-stretch border-l border-[#2A2C32] flex-shrink-0" aria-hidden />
            <WorkspaceTabBar
              workspaces={workspaces}
              activeId={workspaceId}
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
          "flex items-center gap-2 self-stretch flex-shrink-0 " +
          (editMode ? "mx-auto" : "ml-3 pl-3 border-l border-[#2A2C32]")
        }>
          <ViewStatePills viewState={viewState} />
          <button
            onClick={() => setPaletteOpen(true)}
            className="px-2 py-0.5 text-xs border border-helios-line bg-helios-panel text-helios-dim hover:border-asu-gold hover:text-helios-text rounded-sm cursor-pointer transition-colors flex items-center gap-1 font-mono-num"
            title="Open command palette"
          >
            <span>⌘K</span>
          </button>
          <button
            onClick={() => openHelp()}
            className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
            title="Open Help &amp; Wiki"
          >
            Help
          </button>
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
              <EditMoreMenu
                onSnapToGrid={handleSnapToGrid}
                onResetAll={handleResetWorkspaces}
              />
            </>
          )}
          {!editMode && (
            <>
              <PlaybackControls emitter={emitter} viewState={viewState} ext={ext} playing={playing} onPlayingChange={onPlayingChange} />
              <span className="font-mono-num"><CursorClock emitter={emitter} /></span>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0 min-w-0">
        <SessionPanel
          sessions={sessions}
          primaryId={primary.id}
          onToggleVisibility={toggleVisibility}
          onSetPrimary={setPrimaryId}
          onConfigureLaps={(id) => setLapConfigSessionId(id)}
          onAddSession={handleAddSessionDialog}
          onRemoveSession={handleRemoveSession}
          lapSelectionEmitter={lapSelectionEmitter}
          lapSelection={lapSelection}
        />
        <main className="flex-1 relative min-w-0">
          {editMode && <GridOverlay />}
          {workspace.tiles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center text-[#9097A0] text-sm max-w-xs px-4">
                <div className="text-[#D8DCE2] font-medium mb-1">No tiles</div>
                <div>
                  {editMode
                    ? "Press + Add tile to place a widget."
                    : "Edit then + Add tile, or press ⌘K."}
                </div>
              </div>
            </div>
          )}
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

      <footer className="h-6 flex items-center px-3 border-t border-[#2A2C32] text-[10px] text-[#9097A0]">
        {visibleSessions.length} session{visibleSessions.length === 1 ? "" : "s"} visible
        {" · "}primary: {primary.store.list().length} channels
        {" · "}range {formatRangeSeconds(ext.endUs - ext.startUs)}
        {" · "}{workspace.tiles.length} tile{workspace.tiles.length === 1 ? "" : "s"}
        <LapCompareSegment sessions={sessions} selection={lapSelection} />
        {" · "}<FpsCounter />
        {editMode && <span className="ml-2 text-[#FFC627]">· editing</span>}
      </footer>

      {channelsOpen && (
        <ChannelsModal
          channels={primary.store.list()}
          sessionLabel={primary.label}
          sourceHeaders={primary.store.listSourceHeaders()}
          overrides={primary.channelOverrides}
          onOverrideChange={(canonicalId, sourceHeader) =>
            handleChannelOverrideChange(primary.id, canonicalId, sourceHeader)
          }
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
      <ShortcutsOverlay
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <HelpModal
        open={helpState.open}
        initialSlug={helpState.slug}
        onClose={closeHelp}
      />
    </div>
  );
}

/** Footer segment that shows Main lap time, Ref lap time, and Δ whenever
 *  the global lap selection has both. Silent otherwise so the footer doesn't
 *  flicker between content/no-content as the user assigns laps. */
function LapCompareSegment({ sessions, selection }: { sessions: LoadedSession[]; selection: LapSelection }) {
  if (!selection.main || !selection.ref) return null;
  const mainSes = sessions.find((s) => s.id === selection.main!.sessionId);
  const refSes = sessions.find((s) => s.id === selection.ref!.sessionId);
  if (!mainSes?.laps || !refSes?.laps) return null;
  const mainLap = mainSes.laps.laps[selection.main.lapIndex];
  const refLap = refSes.laps.laps[selection.ref.lapIndex];
  if (!mainLap || !refLap) return null;
  const delta = mainLap.durationS - refLap.durationS;
  const deltaColor =
    delta > 0.005 ? "#EF5350"
    : delta < -0.005 ? "#66BB6A"
    : "#D8DCE2";
  return (
    <span className="ml-2 pl-2 border-l border-[#2A2C32] font-mono-num tabular-nums">
      <span className="text-[#9097A0]">Main</span>{" "}
      <span className="text-[#D8DCE2]">{formatLapTime(mainLap.durationS * 1_000_000)}</span>
      <span className="text-[#9097A0]"> · Ref</span>{" "}
      <span className="text-[#D8DCE2]">{formatLapTime(refLap.durationS * 1_000_000)}</span>
      <span className="text-[#9097A0]"> · Δ</span>{" "}
      <span style={{ color: deltaColor }}>{delta >= 0 ? "+" : "−"}{Math.abs(delta).toFixed(2)}s</span>
    </span>
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

/** Compact menu — opens a small popover with CSV / KML export actions. */
function ExportMenuButton({ sessions, primary, viewState }: {
  sessions: LoadedSession[]; primary: LoadedSession; viewState: ViewStateEmitter;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  // Export can reject (dynamic import failure, no GPS channels for KML, a
  // filesystem error). Surface it inline and keep the menu open on failure
  // instead of leaking an unhandled rejection and silently closing.
  async function exportCsv(scope: "session" | "zoom") {
    setErr(null);
    try {
      const { exportSessionCsv } = await import("./lib/csv-export");
      const range = scope === "zoom" ? viewState.get().zoomRange : null;
      await exportSessionCsv(primary, range);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  async function exportKml() {
    setErr(null);
    try {
      const { exportSessionKml } = await import("./lib/kml-export");
      await exportSessionKml(primary);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  // Keep `sessions` referenced so React's exhaustive-deps lint stays quiet
  // even though we only consume the primary right now; multi-session export
  // is on the roadmap.
  void sessions;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Export"
      >Export ▾</button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-[#0E0E10] border border-[#2A2C32] z-30 text-xs">
          <button type="button" onClick={() => exportCsv("session")} className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]">CSV — primary session, full</button>
          <button type="button" onClick={() => exportCsv("zoom")} className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]">CSV — primary, zoom range</button>
          <button type="button" onClick={() => exportKml()} className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]">KML — GPS path (primary)</button>
          {err && <div role="alert" className="px-2 py-1.5 text-[#EF5350] border-t border-[#2A2C32]">Export failed: {err}</div>}
        </div>
      )}
    </div>
  );
}

function EditMoreMenu({ onSnapToGrid, onResetAll }: {
  onSnapToGrid: () => void; onResetAll: () => void;
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
        aria-label="More edit actions"
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="More actions"
      >⋯</button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-[#0E0E10] border border-[#2A2C32] z-30 text-xs">
          <button
            onClick={() => { onSnapToGrid(); setOpen(false); }}
            className="w-full text-left px-2 py-1.5 hover:bg-[#16171B]"
            title="Snap every tile's position and size to the grid; sizes are preserved"
          >Snap to grid</button>
          <button
            onClick={() => { onResetAll(); setOpen(false); }}
            className="w-full text-left px-2 py-1.5 text-[#9097A0] hover:bg-[#16171B] hover:text-[#EF5350]"
            title="Reset every workspace to its built-in default"
          >Reset all workspaces</button>
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
    const inBounds = (us: number, b: { startUs: number; endUs: number }) =>
      us >= b.startUs && us < b.endUs;
    const b0 = effectiveBounds();
    // Whether the cursor was inside the active bounds on the previous frame.
    // We only wrap-to-start when playback runs OFF the end from *inside* the
    // window. If the cursor is currently outside (e.g. the user just zoomed to
    // a window that doesn't contain the cursor), we don't yank it to the start;
    // we let it advance and start looping once it has entered the window.
    let wasInBounds = inBounds(cursorStartUs, b0);
    if (cursorStartUs >= b0.endUs - 1000 || cursorStartUs < b0.startUs) {
      // Starting play at (or past) the end, or before the start, begins from
      // the window start — the natural "press play, watch from the top" case.
      cursorStartUs = b0.startUs;
      emitter.emit(cursorStartUs);
      lastWrittenUs = cursorStartUs;
      wasInBounds = true;
    }

    const tick = () => {
      const b = effectiveBounds();
      const currentUs = emitter.get();
      if (currentUs !== lastWrittenUs) {
        // Cursor moved out from under us (user scrubbed); re-base from there.
        wallStartMs = performance.now();
        cursorStartUs = currentUs;
        wasInBounds = inBounds(currentUs, b);
      }
      const wallElapsedMs = performance.now() - wallStartMs;
      let next = Math.round(cursorStartUs + wallElapsedMs * 1000 * speedRef.current);
      const nextInBounds = inBounds(next, b);
      // Loop to the window start only when we were inside the window and have
      // now run off its end (or under its start). Intentional behavior: at the
      // end of the range, playback LOOPS back to the start rather than stopping
      // — keeps a session under continuous review without re-pressing play. If
      // the cursor was already outside the window (a fresh zoom moved it out of
      // view), we leave `next` alone so we don't snap the user to the start.
      if (!nextInBounds && wasInBounds) {
        next = b.startUs;
        wallStartMs = performance.now();
        cursorStartUs = next;
      }
      wasInBounds = inBounds(next, b);
      emitter.emit(next);
      lastWrittenUs = next;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, emitter]);

  // Read the latest `playing` through a ref so the Space listener can be
  // attached exactly once instead of being torn down and re-added on every
  // play/pause toggle (which churned a window listener each press). The prop
  // setter takes a plain boolean, so we can't use a functional updater here —
  // the ref gives us the same "latest value" guarantee.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      setPlaying(!playingRef.current);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

function basenameOf(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

/** Format a µs span as a footer "range" string in seconds. Guards a non-finite
 *  span (e.g. an empty store whose extent is ±Infinity) and rounds to 1 dp so
 *  the footer doesn't print a 15-digit float. */
function formatRangeSeconds(spanUs: number): string {
  if (!Number.isFinite(spanUs)) return "—";
  return `${(spanUs / 1_000_000).toFixed(1)}s`;
}

/** crypto.randomUUID() is only defined in a secure context (https / localhost
 *  / Tauri). Outside one (e.g. a plain-http dev server, or an older webview)
 *  it's undefined and throws. Fall back to a v4-shaped id built from
 *  getRandomValues, and finally to Math.random so workspace creation/duplication
 *  never hard-crashes the app. */
function safeUUID(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    try { return c.randomUUID(); } catch { /* fall through */ }
  }
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last-resort, non-cryptographic. Adequate for local workspace ids.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

