// Pure study importer — the inverse of lib/export/buildJson.ts. Takes the text
// of an exported bundle (a single `{ meta, params, results, derived }` study or
// a `{ studies: [...] }` workspace dump) and reconstructs live Study objects so
// they can be dropped back into the studies map and viewed/re-ranked.
//
// No Tauri / React imports: this is unit-testable in isolation. ID assignment is
// injected (idFor) so callers control uniqueness and tests stay deterministic.
// Bad bundles are skipped with a human-readable warning rather than aborting the
// whole import — one corrupt study shouldn't sink a workspace dump.

import type {
  CycleStats,
  OptimizationStudy,
  OptimizationTrial,
  SingleRpmStudy,
  Study,
  StudyKind,
  StudyStatus,
  SweepPoint,
  SweepStudy,
} from "../../state/types";

export interface ImportResult {
  studies: Study[];
  warnings: string[];
}

const KINDS: StudyKind[] = ["single-rpm", "sweep", "optimization"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Split the parsed JSON into raw per-study bundles. Accepts a workspace
 *  envelope (`{ studies: [...] }`), a single bundle (`{ meta, ... }`), or a
 *  bare array of bundles. Throws only when the shape is unrecognizable. */
function bundlesFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (isObj(root)) {
    if (Array.isArray(root.studies)) return root.studies;
    if (isObj(root.meta)) return [root];
  }
  throw new Error("Unrecognized file — expected a CFD study or workspace export.");
}

/** Reconstruct one Study from a bundle, or throw with a reason. */
function studyFromBundle(bundle: unknown, id: string): Study {
  if (!isObj(bundle) || !isObj(bundle.meta)) {
    throw new Error("missing meta block");
  }
  const meta = bundle.meta;
  const kind = meta.kind as StudyKind;
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${String(meta.kind)}"`);

  const configPath = typeof meta.configPath === "string" ? meta.configPath : "(imported)";
  const status: StudyStatus = (typeof meta.status === "string" ? meta.status : "done") as StudyStatus;
  const startedAt = typeof meta.startedAt === "number" ? meta.startedAt : Date.now();
  const finishedAt = typeof meta.finishedAt === "number" ? meta.finishedAt : undefined;
  const base = { id, status, configPath, startedAt, ...(finishedAt != null ? { finishedAt } : {}) };

  const results = isObj(bundle.results) ? bundle.results : {};
  const derived = isObj(bundle.derived) ? bundle.derived : {};

  if (kind === "single-rpm") {
    const cycles = Array.isArray(results.cycles) ? (results.cycles as CycleStats[]) : [];
    const study: SingleRpmStudy = {
      ...base,
      kind: "single-rpm",
      params: bundle.params as SingleRpmStudy["params"],
      cycles,
    };
    return study;
  }

  if (kind === "sweep") {
    const points = Array.isArray(results.points) ? (results.points as SweepPoint[]) : [];
    // Defensively ensure each point has a cycles array (older bundles may omit).
    const safePoints = points.map((p) => ({ ...p, cycles: Array.isArray(p.cycles) ? p.cycles : [] }));
    const study: SweepStudy = {
      ...base,
      kind: "sweep",
      params: bundle.params as SweepStudy["params"],
      points: safePoints,
    };
    return study;
  }

  // optimization
  const params = bundle.params as OptimizationStudy["params"];
  if (!isObj(params) || !Array.isArray(params.tunables)) {
    throw new Error("optimization bundle missing params.tunables");
  }
  const trials = Array.isArray(results.trials) ? (results.trials as OptimizationTrial[]) : [];
  const objectiveDirection =
    derived.direction === "minimize" || derived.direction === "maximize"
      ? derived.direction
      : params.objective?.direction ?? "maximize";
  const study: OptimizationStudy = {
    ...base,
    kind: "optimization",
    params,
    trials,
    bestTrialIdx: typeof derived.bestTrialIdx === "number" ? derived.bestTrialIdx : null,
    bestObjectiveValue: typeof derived.bestObjectiveValue === "number" ? derived.bestObjectiveValue : null,
    parameterPaths: params.tunables.map((t) => t.path),
    objectiveDirection,
  };
  return study;
}

/** Parse exported JSON text into live studies. `idFor(index)` mints a unique
 *  id per imported study (the original backend jobId is intentionally NOT
 *  reused — an import is a fresh study so it can't collide with a live run). */
export function parseStudyImport(
  text: string,
  idFor: (index: number) => string,
): ImportResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { studies: [], warnings: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  let raw: unknown[];
  try {
    raw = bundlesFrom(root);
  } catch (e) {
    return { studies: [], warnings: [e instanceof Error ? e.message : String(e)] };
  }

  const studies: Study[] = [];
  const warnings: string[] = [];
  raw.forEach((bundle, i) => {
    try {
      studies.push(studyFromBundle(bundle, idFor(i)));
    } catch (e) {
      warnings.push(`Skipped study ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (studies.length === 0 && warnings.length === 0) {
    warnings.push("No studies found in file.");
  }
  return { studies, warnings };
}
