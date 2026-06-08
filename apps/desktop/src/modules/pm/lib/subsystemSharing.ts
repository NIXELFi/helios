// Multi-subteam subsystem sharing. The `pm.subsystems` table has a single
// `subteam_id` (primary owner), so a subsystem being shared across additional
// subteams can't be persisted server-side without a schema change. Until that
// lands, the extra associations are kept per-project in localStorage so the
// sharing still works and survives reloads.
//
// Shape: { [subsystemId]: string[] }  — the ADDITIONAL subteam ids it's shared
// to (the primary subteam_id is implicit and never stored here).

import type { Subsystem } from "@helios/pm-ui";

export type SharingMap = Record<string, string[]>;

function storageKey(projectId: string): string {
  return `helios:subsystemSharing:${projectId}`;
}

export function recallSharing(projectId: string): SharingMap {
  if (typeof window === "undefined" || !projectId) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: SharingMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberSharing(projectId: string, map: SharingMap): void {
  if (typeof window === "undefined" || !projectId) return;
  try {
    // Drop empty entries so the store stays tidy.
    const tidy: SharingMap = {};
    for (const [k, v] of Object.entries(map)) if (v.length > 0) tidy[k] = [...new Set(v)];
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(tidy));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

// Every subteam id a subsystem belongs to: its primary plus any shared-to ids.
export function subteamIdsForSubsystem(ss: Subsystem, sharing: SharingMap): string[] {
  return [...new Set([ss.subteam_id, ...(sharing[ss.id] ?? [])])];
}

// Subsystems that belong to a given subteam (primary OR shared).
export function subsystemsForSubteam(
  subsystems: ReadonlyArray<Subsystem>,
  subteamId: string,
  sharing: SharingMap,
): Subsystem[] {
  return subsystems.filter((ss) => subteamIdsForSubsystem(ss, sharing).includes(subteamId));
}
