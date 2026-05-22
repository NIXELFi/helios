// Versioned localStorage for the CFD module. v2 persists the full
// study (including per-cycle stats and sweep points) so a dev-server
// restart preserves the data the user already paid solver time for.
// Capture artifacts (P-V, profiles, wave frames) live on disk and are
// reloaded on demand via cfd_load_capture.
//
// Quota math: a single-RPM run with 40 cycles is ~12 KB JSON; a
// sweep with 23 RPMs * 18 cycles is ~140 KB. Capping at 20 studies
// keeps us under 5 MB even pessimistically.

import type { Study } from "../state/types";

const KEY_V2 = "helios.cfd.v2";
const KEY_V1 = "helios.cfd.v1";   // legacy: header-only
const MAX_STUDIES = 20;

export interface Persisted {
  lastConfigPath: string | null;
  studies: Study[];
}

const EMPTY: Persisted = { lastConfigPath: null, studies: [] };

export function loadPersisted(): Persisted {
  try {
    const raw = window.localStorage.getItem(KEY_V2);
    if (raw) {
      const parsed = JSON.parse(raw) as Persisted;
      return {
        lastConfigPath: parsed.lastConfigPath ?? null,
        studies: Array.isArray(parsed.studies) ? parsed.studies.slice(0, MAX_STUDIES) : [],
      };
    }
    // Fall back to v1 (header-only) if it still exists. Migrate
    // forward by re-materializing empty cycles/points arrays — the
    // user re-runs to refill. Drop v1 once migrated.
    const v1 = window.localStorage.getItem(KEY_V1);
    if (v1) {
      try { window.localStorage.removeItem(KEY_V1); } catch { /* ignore */ }
      const parsed = JSON.parse(v1) as { lastConfigPath?: string | null; studies?: unknown[] };
      const headers = Array.isArray(parsed.studies) ? parsed.studies : [];
      const studies: Study[] = headers.map((h) => {
        const hh = h as { kind: string; [k: string]: unknown };
        if (hh.kind === "sweep") {
          return { ...(hh as object), points: [] } as unknown as Study;
        }
        return { ...(hh as object), cycles: [] } as unknown as Study;
      });
      return {
        lastConfigPath: parsed.lastConfigPath ?? null,
        studies: studies.slice(0, MAX_STUDIES),
      };
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

export function savePersisted(p: Persisted): void {
  const baseStudies = p.studies.slice(0, MAX_STUDIES).map((s) => {
    // Strip transient in-flight buffer fields so we don't restore
    // partial state on reload.
    if (s.kind === "sweep") {
      const { inFlight: _drop, ...rest } = s;
      return rest as Study;
    }
    return s;
  });

  // Try full-fidelity first. If we hit a quota (5MB localStorage cap),
  // degrade: drop per-cycle arrays from sweep points (keeps shape +
  // last_cycle stats, loses drill-down history). If THAT still fails,
  // drop single-RPM cycles too. If THAT still fails, persist headers
  // only. Each level keeps the studies list intact.
  const attempts: Array<(studies: Study[]) => Study[]> = [
    (xs) => xs,
    (xs) => xs.map((s) => {
      if (s.kind === "sweep") {
        return {
          ...s,
          points: s.points.map((pt) => ({ ...pt, cycles: [] })),
        };
      }
      if (s.kind === "optimization") {
        return {
          ...s,
          trials: s.trials.map((t) => ({
            ...t,
            sweepPoints: t.sweepPoints?.map((pt) => ({ ...pt, cycles: [] })) ?? null,
          })),
        };
      }
      return s;
    }),
    (xs) => xs.map((s) => {
      if (s.kind === "sweep") {
        return { ...s, points: s.points.map((pt) => ({ ...pt, cycles: [] })) };
      }
      if (s.kind === "optimization") {
        // Drop sweep points entirely on each trial; keep param values + objective.
        return {
          ...s,
          trials: s.trials.map((t) => ({ ...t, sweepPoints: null })),
        };
      }
      return { ...s, cycles: [] };
    }),
    (xs) => xs.map((s) => {
      if (s.kind === "sweep") {
        return { ...s, points: [] };
      }
      if (s.kind === "optimization") {
        return { ...s, trials: [] };
      }
      return { ...s, cycles: [] };
    }),
  ];

  for (const strip of attempts) {
    try {
      const trimmed: Persisted = {
        lastConfigPath: p.lastConfigPath ?? null,
        studies: strip(baseStudies),
      };
      window.localStorage.setItem(KEY_V2, JSON.stringify(trimmed));
      return; // succeeded
    } catch {
      // Try next degradation level.
    }
  }
  // All attempts failed — fall back to writing just the last config
  // path. Better than nothing; means the studies list will be empty
  // on next load, but the user's open config persists.
  try {
    window.localStorage.setItem(KEY_V2, JSON.stringify({
      lastConfigPath: p.lastConfigPath ?? null, studies: [],
    }));
  } catch { /* truly unavailable storage; ignore */ }
}
