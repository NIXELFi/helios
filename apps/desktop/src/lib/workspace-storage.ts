import type { Workspace } from "../workspaces/types";
import { WORKSPACES as BUILTIN_WORKSPACES } from "../workspaces";
import { colorForIndex } from "./session";

// localStorage key stays "helios.workspaces.v1" for backward-compat;
// only the in-blob `version` field changes.
const STORAGE_KEY = "helios.workspaces.v1";
const CURRENT_VERSION = 5;

interface StoredV1 {
  version: 1;
  workspaces: Array<Omit<Workspace, "color">>;
}
interface StoredV2 {
  version: 2;
  workspaces: Workspace[];
}
interface StoredV3 {
  version: 3;
  workspaces: Workspace[];
}
interface StoredV4 {
  version: 4;
  workspaces: Workspace[];
}
interface StoredV5 {
  version: 5;
  workspaces: Workspace[];
}
type Stored = StoredV1 | StoredV2 | StoredV3 | StoredV4 | StoredV5;

/** Load workspaces from localStorage, falling back to (and seeding) the
 *  built-ins on first use or when the saved blob is unreadable. v1 blobs
 *  are migrated to v2 in-place by filling color from SESSION_PALETTE. */
export function loadWorkspaces(): Workspace[] {
  if (typeof localStorage === "undefined") return cloneBuiltins();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seeded = cloneBuiltins();
    saveWorkspaces(seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) {
      throw new Error("malformed");
    }
    if (parsed.version === CURRENT_VERSION) {
      // Validate each workspace has the required shape before returning.
      // A truncated or partially-written blob could have valid version/array
      // shape but corrupt individual entries — reject the whole blob rather
      // than handing the app poisoned workspaces.
      if (!parsed.workspaces.every(isValidWorkspace)) throw new Error("malformed workspace");
      return parsed.workspaces;
    }
    if (parsed.version === 1) {
      const v2: Workspace[] = parsed.workspaces.map((w, i) => ({
        ...w,
        color: colorForIndex(i),
      }));
      const v3 = migrateV2ToV3(v2);
      const v4 = migrateV3ToV4(v3);
      const v5 = migrateV4ToV5(v4);
      saveWorkspaces(v5);
      return v5;
    }
    if (parsed.version === 2) {
      const v3 = migrateV2ToV3(parsed.workspaces);
      const v4 = migrateV3ToV4(v3);
      const v5 = migrateV4ToV5(v4);
      saveWorkspaces(v5);
      return v5;
    }
    if (parsed.version === 3) {
      const v4 = migrateV3ToV4(parsed.workspaces);
      const v5 = migrateV4ToV5(v4);
      saveWorkspaces(v5);
      return v5;
    }
    if (parsed.version === 4) {
      const v5 = migrateV4ToV5(parsed.workspaces);
      saveWorkspaces(v5);
      return v5;
    }
  } catch {
    // fall through to seed
  }
  const seeded = cloneBuiltins();
  saveWorkspaces(seeded);
  return seeded;
}

/** v3→v4 defensive migration: if the user has no workspace whose id is
 *  "lap-analysis" (most commonly because they renamed/deleted it before the
 *  v2→v3 migration ran), seed a fresh one from the built-ins so they can
 *  discover the Δt feature. Runs once per blob bump — if the user deletes
 *  it again, it stays deleted. */
function migrateV3ToV4(workspaces: Workspace[]): Workspace[] {
  if (workspaces.some((w) => w.id === "lap-analysis")) return workspaces;
  const fresh = cloneBuiltins().find((w) => w.id === "lap-analysis");
  if (!fresh) return workspaces;
  return [...workspaces, fresh];
}

/** v2→v3 migration. Two changes:
 *
 *  1. For an existing workspace with id "lap-analysis", drop a Δt-vs-distance
 *     tile in if it doesn't already have one. The distance-strip (if present)
 *     is shrunk a touch to make room.
 *
 *  2. If NO workspace has id "lap-analysis" — most commonly because the user
 *     deleted it earlier — append a fresh copy from the bundled defaults so
 *     the user doesn't have to hunt for the new feature. They can still
 *     delete it again; this migration only runs once per blob bump.
 *
 *  Non-lap-analysis workspaces are untouched in both cases. */
function migrateV2ToV3(workspaces: Workspace[]): Workspace[] {
  const augmented = workspaces.map((w) => {
    if (w.id !== "lap-analysis") return w;
    if (w.tiles.some((t) => t.widgetType === "lap_delta")) return w;
    const tiles = w.tiles.map((t) => {
      if (t.id === "distance-strip") return { ...t, h: Math.min(t.h, 0.18) };
      return t;
    });
    tiles.push({
      id: "lap-delta",
      widgetType: "lap_delta",
      config: {},
      x: 0, y: 0.63, w: 1, h: 0.12,
    });
    return { ...w, tiles };
  });
  if (!augmented.some((w) => w.id === "lap-analysis")) {
    const fresh = cloneBuiltins().find((w) => w.id === "lap-analysis");
    if (fresh) augmented.push(fresh);
  }
  return augmented;
}

/** v4→v5 migration: drop a sector-splits tile into the lap-analysis
 *  workspace if it doesn't already have one. Sized to slot between
 *  time-report and lap-panel — narrow tiles in the top row are nudged to
 *  make room. Non-lap-analysis workspaces are untouched. */
function migrateV4ToV5(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((w) => {
    if (w.id !== "lap-analysis") return w;
    if (w.tiles.some((t) => t.widgetType === "sector_table")) return w;
    // We don't try to remap the user's manual layout perfectly — that's
    // futile if they've fully customized. Just append; the user can
    // move/resize. The default-builtin layout (still has its original IDs)
    // gets the precision treatment so first-run users see a tidy grid.
    if (w.tiles.some((t) => t.id === "time-report" && t.w >= 0.30 && t.y < 0.05)) {
      // Default layout — shrink time-report + lap-panel and slot sector-table.
      // Spread each tile to avoid mutating the original tile objects (the
      // caller's array was shallow-copied, so the tile references are shared).
      const tiles = w.tiles.map((t) => {
        if (t.id === "time-report" && t.y < 0.05) return { ...t, w: 0.22 };
        if (t.id === "lap-panel" && t.y < 0.05) return { ...t, x: 0.42, w: 0.13 };
        if (t.id === "gps-track" && t.y < 0.05) return { ...t, x: 0.55, w: 0.45 };
        return t;
      });
      tiles.push({
        id: "sector-table",
        widgetType: "sector_table",
        config: { sectorCount: 3, maxRows: 6, hideUntrusted: true },
        x: 0.22, y: 0, w: 0.20, h: 0.45,
      });
      return { ...w, tiles };
    } else {
      // User-customized layout — just append at the bottom; they can move.
      const tiles = [
        ...w.tiles,
        {
          id: "sector-table",
          widgetType: "sector_table" as const,
          config: { sectorCount: 3, maxRows: 6, hideUntrusted: true },
          x: 0, y: 0.85, w: 0.5, h: 0.15,
        },
      ];
      return { ...w, tiles };
    }
  });
}

/** Persist the current workspaces array at the current schema version. */
export function saveWorkspaces(workspaces: Workspace[]): void {
  if (typeof localStorage === "undefined") return;
  const state: StoredV5 = { version: 5, workspaces };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Replace the stored workspaces with a fresh copy of the bundled built-ins.
 *  Returns the new array so callers can update state. */
export function resetToBuiltins(): Workspace[] {
  const fresh = cloneBuiltins();
  saveWorkspaces(fresh);
  return fresh;
}

function cloneBuiltins(): Workspace[] {
  // Deep-clone so user edits can't mutate the source-of-truth defaults at
  // module level.
  return JSON.parse(JSON.stringify(BUILTIN_WORKSPACES)) as Workspace[];
}

/** Minimal structural validation for a persisted workspace entry. Rejects
 *  blobs where the id/label/tiles fields are missing or wrong type so a
 *  truncated write can't surface as a workspace with undefined properties. */
function isValidWorkspace(w: unknown): w is Workspace {
  if (!w || typeof w !== "object") return false;
  const ww = w as Record<string, unknown>;
  return (
    typeof ww.id === "string" &&
    typeof ww.label === "string" &&
    Array.isArray(ww.tiles)
  );
}
