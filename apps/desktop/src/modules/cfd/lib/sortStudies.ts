// Pure comparator for the Studies list. Extracted from StudiesScreen so the
// ordering can be unit-tested without rendering (the context-driven screen
// tests can't control ids / timestamps). Default ordering stays newest-first
// so shipped behaviour is unchanged.

import type { Study } from "../state/types";
import { studyName } from "./studyName";

export type SortKey = "startedAt" | "name" | "kind" | "status";
export type SortDir = "asc" | "desc";

export interface SortPref {
  key: SortKey;
  dir: SortDir;
}

// Kind ordering follows the study-kind progression (single run → sweep →
// optimization), matching the order kinds appear in the "New study" picker.
const KIND_RANK: Record<Study["kind"], number> = {
  "single-rpm": 0,
  sweep: 1,
  optimization: 2,
};

// Status ordering follows the run lifecycle: in-flight first, then terminal
// states. Active runs surface at the top in ascending order.
const STATUS_RANK: Record<Study["status"], number> = {
  running: 0,
  cancelling: 1,
  done: 2,
  cancelled: 3,
  error: 4,
  idle: 5,
};

// Primary comparison for a given key (ascending sense). Ties (0) fall through
// to the deterministic tie-break below.
function primaryCompare(a: Study, b: Study, key: SortKey): number {
  switch (key) {
    case "name":
      return studyName(a).localeCompare(studyName(b), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    case "kind":
      return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    case "status":
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    case "startedAt":
      return a.startedAt - b.startedAt;
  }
}

/** Sort a copy of `list` by the given key/direction. Always tie-breaks by
 *  startedAt (newest first) then id, so the order is deterministic and stable
 *  regardless of input order. */
export function sortStudies(list: Study[], { key, dir }: SortPref): Study[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const primary = primaryCompare(a, b, key);
    if (primary !== 0) return primary * sign;
    // Tie-break: newest first, then id — independent of the chosen direction.
    if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
    return a.id.localeCompare(b.id);
  });
}
