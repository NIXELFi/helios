// Per-study export dispatcher. Maps a Study to the concrete export ACTIONS its
// kind supports, wiring each pure builder to the io.ts disk seam. The screens
// (Studies list + each results screen) call exportActionsFor() and render the
// returned actions in an ExportMenu — they never reach for a builder directly,
// so the "what does this kind export?" decision lives in exactly one place.

import type {
  OptimizationStudy,
  ParameterMeta,
  SingleRpmStudy,
  Study,
  SweepStudy,
} from "../../state/types";
import {
  buildOptimizationCurvesCsv,
  buildOptimizationTrialsCsv,
  buildSingleRpmCsv,
  buildSweepCsv,
  buildSweepCyclesCsv,
} from "./buildCsv";
import { buildStudyJson } from "./buildJson";
import { fileTimestamp, saveTextFile, slugify } from "./io";

/** One named export. `run` resolves to the written path, or null when the
 *  save dialog was cancelled. */
export interface ExportAction {
  id: string;
  label: string;
  run: () => Promise<string | null>;
}

export interface ExportDeps {
  getSchema?: (configPath: string) => Promise<ParameterMeta[]>;
}

/** Last path segment of a config path, without extension — the human-meaningful
 *  part of the filename. Handles both "/" and "\" separators. */
function basename(p: string): string {
  const seg = p.split(/[\\/]/).pop() ?? p;
  return seg.replace(/\.[^.]+$/, "");
}

/** Shared filename stem: cfd-<kind>-<config>-<timestamp>. */
function fileStem(study: Study): string {
  return `cfd-${study.kind}-${slugify(basename(study.configPath))}-${fileTimestamp()}`;
}

/** Best-effort parameter schema fetch — optimization exports enrich units from
 *  it when available, but a failure must never block the export (catch → null). */
async function trySchema(
  study: Study,
  deps: ExportDeps,
): Promise<ParameterMeta[] | null> {
  if (!deps.getSchema) return null;
  try {
    return await deps.getSchema(study.configPath);
  } catch {
    return null;
  }
}

function singleRpmActions(study: SingleRpmStudy): ExportAction[] {
  const stem = fileStem(study);
  return [
    {
      id: "single-cycles-csv",
      label: "Cycles CSV",
      run: () => saveTextFile(`${stem}-cycles`, "csv", buildSingleRpmCsv(study)),
    },
    {
      id: "single-study-json",
      label: "Study JSON",
      run: () => saveTextFile(stem, "json", buildStudyJson(study)),
    },
  ];
}

function sweepActions(study: SweepStudy): ExportAction[] {
  const stem = fileStem(study);
  const actions: ExportAction[] = [
    {
      id: "sweep-per-rpm-csv",
      label: "Per-RPM CSV",
      run: () => saveTextFile(`${stem}-per-rpm`, "csv", buildSweepCsv(study)),
    },
  ];
  // Cycles CSV only when at least one point captured per-cycle data. Build the
  // CSV ONCE (it's the expensive part) and reuse it for both the availability
  // check and the action — the previous code rebuilt it on every menu render.
  const cyclesCsv = buildSweepCyclesCsv(study);
  if (cyclesCsv != null) {
    actions.push({
      id: "sweep-cycles-csv",
      label: "Cycles CSV",
      run: () => saveTextFile(`${stem}-cycles`, "csv", cyclesCsv),
    });
  }
  actions.push({
    id: "sweep-study-json",
    label: "Study JSON",
    run: () => saveTextFile(stem, "json", buildStudyJson(study)),
  });
  return actions;
}

function optimizationActions(study: OptimizationStudy, deps: ExportDeps): ExportAction[] {
  const stem = fileStem(study);
  const actions: ExportAction[] = [
    {
      id: "opt-trials-csv",
      label: "Trials CSV",
      run: async () => {
        const schema = await trySchema(study, deps);
        return saveTextFile(`${stem}-trials`, "csv", buildOptimizationTrialsCsv(study, schema));
      },
    },
  ];
  // Trial curves CSV only when at least one done trial recorded sweepPoints.
  // Build ONCE and reuse for the check + action (was rebuilt per menu render).
  const curvesCsv = buildOptimizationCurvesCsv(study);
  if (curvesCsv != null) {
    actions.push({
      id: "opt-curves-csv",
      label: "Trial curves CSV",
      run: () => saveTextFile(`${stem}-curves`, "csv", curvesCsv),
    });
  }
  actions.push({
    id: "opt-study-json",
    label: "Study JSON",
    run: async () => {
      const schema = await trySchema(study, deps);
      return saveTextFile(stem, "json", buildStudyJson(study, { schema }));
    },
  });
  return actions;
}

/** The export actions a study supports, given optional schema-fetch deps. */
export function exportActionsFor(study: Study, deps: ExportDeps = {}): ExportAction[] {
  if (study.kind === "single-rpm") return singleRpmActions(study);
  if (study.kind === "sweep") return sweepActions(study);
  return optimizationActions(study, deps);
}
