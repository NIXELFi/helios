import type { Workspace } from "../workspaces/types";
import { WORKSPACES as BUILTIN_WORKSPACES } from "../workspaces";

const STORAGE_KEY = "helios.workspaces.v1";

interface StoredState {
  version: 1;
  workspaces: Workspace[];
}

/** Load workspaces from localStorage, falling back to (and seeding) the
 *  built-ins on first use or when the saved blob is unreadable. */
export function loadWorkspaces(): Workspace[] {
  if (typeof localStorage === "undefined") return cloneBuiltins();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seeded = cloneBuiltins();
    saveWorkspaces(seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed?.version === 1 && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
      return parsed.workspaces;
    }
  } catch {
    // fallthrough to seed
  }
  const seeded = cloneBuiltins();
  saveWorkspaces(seeded);
  return seeded;
}

/** Persist the current workspaces array. */
export function saveWorkspaces(workspaces: Workspace[]): void {
  if (typeof localStorage === "undefined") return;
  const state: StoredState = { version: 1, workspaces };
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
