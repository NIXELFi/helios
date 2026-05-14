/* App-level persisted state that doesn't belong to a single domain module.
 *
 * Today: last active workspace id + recently-opened user CSV paths.
 * Tomorrow: cursor/zoom per primary session, lap-selection overrides, more.
 *
 * Stored as a single versioned blob under "helios.app-state.v1". Keeping it
 * one key means atomic reads/writes — no two callers ever fight over partial
 * state — at the cost of touching the whole blob on every save. That's fine
 * for a few-KB record updated at human-speed.
 */

const STORAGE_KEY = "helios.app-state.v1";

/** Per-session view-state snapshot — cursor position and zoom range. Saved
 *  when the user is the primary session is `sessionId`; restored when that
 *  session is promoted back to primary on a later session. Datums are
 *  intentionally not persisted yet (they're unlabeled vertical lines today
 *  — reviving them across restarts would be more confusing than helpful
 *  without the planned label/author metadata). */
export interface ViewStateSnapshot {
  zoomRange: { startUs: number; endUs: number } | null;
  cursorUs: number;
  /** Vertical marker lines the user dropped via shift-click on a strip
   *  chart. Saved as raw microsecond timestamps. Older snapshots (pre-v1
   *  shipping this field) omit it — readers tolerate the missing field. */
  datums?: number[];
}

/** Saved Main/Ref/Overlays selection — the global lap-comparison state. The
 *  emitter at runtime is a class; this is its serializable shape. */
export interface SavedLapRef {
  sessionId: string;
  lapIndex: number;
}
export interface SavedLapSelection {
  main: SavedLapRef | null;
  ref: SavedLapRef | null;
  overlays: SavedLapRef[];
}

interface AppStateV1 {
  version: 1;
  lastWorkspaceId: string | null;
  /** Absolute paths the user has opened, most-recent first. Capped to keep
   *  the blob bounded. We silently re-load these on next boot — paths that
   *  no longer resolve are dropped during the re-load attempt. */
  recentSessions: string[];
  /** Per-(session id) cursor + zoom. Capped so a user who runs through
   *  hundreds of sessions doesn't bloat the blob. Oldest entries are dropped
   *  on overflow (LRU by last save). */
  viewStateBySession: Record<string, ViewStateSnapshot>;
  /** Last-saved global lap selection. Null when the user has never made an
   *  explicit pick — boot logic falls back to auto-picking the primary's
   *  best/2nd-best laps in that case. */
  lapSelection: SavedLapSelection | null;
}

const RECENT_LIMIT = 32;
const VIEW_STATE_LIMIT = 64;

function defaultState(): AppStateV1 {
  return {
    version: 1,
    lastWorkspaceId: null,
    recentSessions: [],
    viewStateBySession: {},
    lapSelection: null,
  };
}

function loadState(): AppStateV1 {
  if (typeof localStorage === "undefined") return defaultState();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw) as Partial<AppStateV1>;
    if (parsed?.version !== 1) return defaultState();
    return {
      version: 1,
      lastWorkspaceId: typeof parsed.lastWorkspaceId === "string" ? parsed.lastWorkspaceId : null,
      recentSessions: Array.isArray(parsed.recentSessions)
        ? parsed.recentSessions.filter((p): p is string => typeof p === "string")
        : [],
      viewStateBySession: isViewStateMap(parsed.viewStateBySession)
        ? parsed.viewStateBySession
        : {},
      lapSelection: isLapSelection(parsed.lapSelection) ? parsed.lapSelection : null,
    };
  } catch {
    return defaultState();
  }
}

function isLapSelection(x: unknown): x is SavedLapSelection {
  if (x === null) return true;
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<SavedLapSelection>;
  const okRef = (r: unknown): boolean =>
    r === null
    || (typeof r === "object" && r !== null
        && typeof (r as SavedLapRef).sessionId === "string"
        && typeof (r as SavedLapRef).lapIndex === "number");
  if (s.main !== undefined && !okRef(s.main)) return false;
  if (s.ref !== undefined && !okRef(s.ref)) return false;
  if (s.overlays !== undefined) {
    if (!Array.isArray(s.overlays)) return false;
    for (const r of s.overlays) if (!okRef(r) || r === null) return false;
  }
  return true;
}

function isViewStateMap(x: unknown): x is Record<string, ViewStateSnapshot> {
  if (!x || typeof x !== "object") return false;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (typeof k !== "string") return false;
    if (!v || typeof v !== "object") return false;
    const snap = v as Partial<ViewStateSnapshot>;
    if (typeof snap.cursorUs !== "number") return false;
    if (snap.zoomRange !== null && (typeof snap.zoomRange !== "object"
      || typeof (snap.zoomRange as { startUs: unknown }).startUs !== "number"
      || typeof (snap.zoomRange as { endUs: unknown }).endUs !== "number")) {
      return false;
    }
    // datums optional; if present must be a number[].
    if (snap.datums !== undefined && (!Array.isArray(snap.datums) || snap.datums.some((d) => typeof d !== "number"))) {
      return false;
    }
  }
  return true;
}

function saveState(state: AppStateV1): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadLastWorkspaceId(): string | null {
  return loadState().lastWorkspaceId;
}

export function saveLastWorkspaceId(id: string | null): void {
  const s = loadState();
  if (s.lastWorkspaceId === id) return;
  s.lastWorkspaceId = id;
  saveState(s);
}

export function loadRecentSessions(): string[] {
  return loadState().recentSessions;
}

/** Promote `path` to the head of the recent-sessions list, deduping by exact
 *  string match and capping the list at RECENT_LIMIT. */
export function addRecentSession(path: string): void {
  const s = loadState();
  const next = [path, ...s.recentSessions.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
  if (sameOrder(next, s.recentSessions)) return;
  s.recentSessions = next;
  saveState(s);
}

export function removeRecentSession(path: string): void {
  const s = loadState();
  const next = s.recentSessions.filter((p) => p !== path);
  if (next.length === s.recentSessions.length) return;
  s.recentSessions = next;
  saveState(s);
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function loadViewStateFor(sessionId: string): ViewStateSnapshot | null {
  const s = loadState();
  return s.viewStateBySession[sessionId] ?? null;
}

/** Persist cursor + zoom for one session. Capped LRU at VIEW_STATE_LIMIT to
 *  keep the blob bounded; the freshly-saved entry is always retained, and
 *  the rest are kept in object-key-insertion order (which is the order they
 *  were last written — JS objects preserve insertion order). */
export function saveViewStateFor(sessionId: string, snap: ViewStateSnapshot): void {
  const s = loadState();
  // Delete + re-insert so this id moves to the end (newest) of insertion order.
  delete s.viewStateBySession[sessionId];
  s.viewStateBySession[sessionId] = snap;
  const keys = Object.keys(s.viewStateBySession);
  if (keys.length > VIEW_STATE_LIMIT) {
    const drop = keys.slice(0, keys.length - VIEW_STATE_LIMIT);
    for (const k of drop) delete s.viewStateBySession[k];
  }
  saveState(s);
}

export function loadLapSelection(): SavedLapSelection | null {
  return loadState().lapSelection;
}

export function saveLapSelection(sel: SavedLapSelection | null): void {
  const s = loadState();
  // Normalize empty selection to null so we don't grow the blob with
  // {null,null,[]} the moment the app starts up.
  const isEmpty = sel === null || (sel.main === null && sel.ref === null && sel.overlays.length === 0);
  const next: SavedLapSelection | null = isEmpty ? null : sel;
  if (JSON.stringify(s.lapSelection) === JSON.stringify(next)) return;
  s.lapSelection = next;
  saveState(s);
}

/** Test seam: wipe the persisted state. Only used in unit tests. */
export function __resetAppStateForTest(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
