// Versioned localStorage for the CFD module. Stores the last config
// path + a bounded ring of recent study headers (no cycle data).

import type { StudyHeader } from "../state/types";

const KEY = "helios.cfd.v1";
const MAX_HEADERS = 50;

export interface Persisted {
  lastConfigPath: string | null;
  studies: StudyHeader[];
}

const EMPTY: Persisted = { lastConfigPath: null, studies: [] };

export function loadPersisted(): Persisted {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Persisted;
    return {
      lastConfigPath: parsed.lastConfigPath ?? null,
      studies: Array.isArray(parsed.studies) ? parsed.studies.slice(0, MAX_HEADERS) : [],
    };
  } catch {
    return EMPTY;
  }
}

export function savePersisted(p: Persisted): void {
  try {
    const trimmed: Persisted = {
      lastConfigPath: p.lastConfigPath ?? null,
      studies: p.studies.slice(0, MAX_HEADERS),
    };
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Storage may be unavailable (private mode, quota). Non-fatal —
    // session state still lives in memory.
  }
}
