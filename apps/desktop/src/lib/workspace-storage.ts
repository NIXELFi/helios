import type { Workspace } from "../workspaces/types";
import { WORKSPACES as BUILTIN_WORKSPACES } from "../workspaces";
import { SESSION_PALETTE } from "./session";

// localStorage key stays "helios.workspaces.v1" for backward-compat;
// only the in-blob `version` field changes.
const STORAGE_KEY = "helios.workspaces.v1";
const CURRENT_VERSION = 2;

interface StoredV1 {
  version: 1;
  workspaces: Array<Omit<Workspace, "color">>;
}
interface StoredV2 {
  version: 2;
  workspaces: Workspace[];
}
type Stored = StoredV1 | StoredV2;

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
      return parsed.workspaces;
    }
    if (parsed.version === 1) {
      const migrated: Workspace[] = parsed.workspaces.map((w, i) => ({
        ...w,
        color: SESSION_PALETTE[i % SESSION_PALETTE.length]!,
      }));
      saveWorkspaces(migrated);
      return migrated;
    }
  } catch {
    // fall through to seed
  }
  const seeded = cloneBuiltins();
  saveWorkspaces(seeded);
  return seeded;
}

/** Persist the current workspaces array as v2. */
export function saveWorkspaces(workspaces: Workspace[]): void {
  if (typeof localStorage === "undefined") return;
  const state: StoredV2 = { version: 2, workspaces };
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
  return JSON.parse(JSON.stringify(BUILTIN_WORKSPACES)) as Workspace[];
}
