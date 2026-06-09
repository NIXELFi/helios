// Per-trial detail pane shown to the right of the parallel-coords plot.
// Header carries a podium rank badge + Δ-to-best line. A "recipe" card lists
// every parameter path with its sampled value and (when the schema resolves)
// its unit, plus a Copy button that puts `path\tvalue` TSV lines on the
// clipboard. Below that we draw this trial's per-RPM brake torque / power /
// IMEP curves from its stored sweep points; when inspecting a NON-best trial we
// overlay the best trial's curves in muted grey (the sweep-compare idiom) so
// the gap to the leader is visible at a glance.

import { useState } from "react";

import { LinePlot } from "../components/charts/LinePlot";
import { useParameterSchema } from "../lib/useParameterSchema";
import { copyText } from "../lib/export/io";
import type {
  OptimizationTrial,
  ParameterMeta,
} from "../state/types";

/** The active ranking dimension's display contract — label, unit, and value
 *  formatter. Supplied by the results screen so the inspector's headline value
 *  and Δ line always agree with the podium/table (the trial's objectiveValue is
 *  already remapped to this dimension). */
export interface InspectorDim {
  label: string;
  unit: string;
  fmt: (n: number) => string;
}

interface Props {
  trial: OptimizationTrial;
  parameterPaths: string[];
  /** Config path used to resolve parameter units (best-effort). */
  configPath: string;
  /** Active ranking dimension — drives the headline value + unit shown by obj/Δ. */
  dim: InspectorDim;
  /** This trial's 1-based rank, or null when it isn't rankable yet. */
  rank: number | null;
  /** Signed objective gap to the best trial (0 for rank 1; null when n/a). */
  deltaToBest: number | null;
  /** Percentage gap to best (null when best === 0 or n/a). */
  pctOfBest: number | null;
  /** The best trial, for the overlay curves (null when this IS the best). */
  bestTrial: OptimizationTrial | null;
  /** Open the sweep modal seeded with THIS trial's recipe (null = hide). */
  onRunSweep?: () => void;
}

const RANK_BADGE: Record<number, { label: string; cls: string }> = {
  1: { label: "#1", cls: "border-[#FFC627]/60 text-[#FFC627]" },
  2: { label: "#2", cls: "border-[#C0C7D1]/60 text-[#C0C7D1]" },
  3: { label: "#3", cls: "border-[#CD7F32]/60 text-[#CD7F32]" },
};

/** Unit for a parameter path, from the resolved schema ('' when unknown). */
function unitForPath(schema: ParameterMeta[] | null, path: string): string {
  return schema?.find((p) => p.path === path)?.unit ?? "";
}

export function TrialInspector({
  trial,
  parameterPaths,
  configPath,
  dim,
  rank,
  deltaToBest,
  pctOfBest,
  bestTrial,
  onRunSweep,
}: Props) {
  const { schema } = useParameterSchema(configPath);
  const [copied, setCopied] = useState(false);

  const points = trial.sweepPoints ?? [];
  const rpms = points.map((p) => p.rpm);
  const torque = points.map((p) => p.lastCycle.brakeTorqueNm);
  const power = points.map((p) => p.lastCycle.brakePowerKW);
  const imep = points.map((p) => p.lastCycle.imepBar);

  // Overlay the best trial's curves only when this is NOT the best trial.
  const overlay = bestTrial && bestTrial.trialIdx !== trial.trialIdx ? bestTrial : null;
  const overlayPoints = overlay?.sweepPoints ?? [];
  const overlayRpms = overlayPoints.map((p) => p.rpm);

  const badge = rank != null ? RANK_BADGE[rank] : undefined;

  async function copyRecipe() {
    const lines = parameterPaths.map((p) => {
      const v = trial.parameterValues[p];
      return `${p}\t${v !== undefined ? v : ""}`;
    });
    await copyText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-3">
      <header className="text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">
            Trial #{trial.trialIdx}
          </span>
          {badge && (
            <span
              className={
                "rounded-sm border px-1.5 py-[1px] text-[9px] uppercase tracking-wider " +
                badge.cls
              }
            >
              {badge.label}
            </span>
          )}
          {rank != null && rank > 3 && (
            <span className="rounded-sm border border-[#2A2C32] px-1.5 py-[1px] text-[9px] uppercase tracking-wider text-[#9097A0]">
              #{rank}
            </span>
          )}
        </div>
        <div className="mt-1 font-mono text-[#9097A0]">
          {dim.label} = {trial.objectiveValue !== null ? dim.fmt(trial.objectiveValue) : "—"}
          {dim.unit && <span className="ml-1 text-[#5A5F66]">{dim.unit}</span>}
          {trial.wallTimeS !== null && (
            <span className="ml-2 text-[#5A5F66]">{trial.wallTimeS.toFixed(2)} s</span>
          )}
        </div>
        {rank != null && (
          <div className="mt-0.5 font-mono text-[10px] text-[#5A5F66]">
            {/* "best" is gated on rank ONLY (matching podium + table): a tied
                rank-2 trial has deltaToBest === 0 but is NOT the best. */}
            {rank === 1 || deltaToBest == null
              ? rank === 1
                ? "best"
                : "—"
              : `Δ ${deltaToBest > 0 ? "+" : ""}${deltaToBest.toPrecision(3)}${dim.unit ? " " + dim.unit : ""}` +
                (pctOfBest != null
                  ? ` (${pctOfBest > 0 ? "+" : ""}${pctOfBest.toFixed(1)}%)`
                  : "")}
          </div>
        )}
      </header>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <h4 className="text-[10px] uppercase tracking-wider text-[#5A5F66]">Recipe</h4>
          <div className="flex items-center gap-1.5">
            {onRunSweep && (
              <button
                type="button"
                onClick={onRunSweep}
                title="Open the sweep menu with this trial's parameters, to sweep it across RPM"
                className="rounded-sm border border-[#FFC627]/50 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#FFC627] hover:bg-[#FFC627]/10"
              >
                Run sweep
              </button>
            )}
            <button
              type="button"
              onClick={() => void copyRecipe()}
              className="rounded-sm border border-[#2A2C32] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
        <table className="w-full text-[11px]">
          <tbody className="font-mono">
            {parameterPaths.map((p) => {
              const unit = unitForPath(schema, p);
              return (
                <tr key={p} className="border-t border-[#16171B]">
                  <td className="px-2 py-0.5 text-[#9097A0]">{p}</td>
                  <td className="px-2 py-0.5 text-right text-[#D8DCE2]">
                    {trial.parameterValues[p] !== undefined
                      ? trial.parameterValues[p]!.toPrecision(5)
                      : "—"}
                    {unit && trial.parameterValues[p] !== undefined && (
                      <span className="ml-1 text-[#5A5F66]">{unit}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {points.length > 0 && (
        <div className="space-y-2">
          {overlay && (
            <p className="text-[9px] text-[#5A5F66]">
              <span className="mr-1 inline-block h-[2px] w-3 align-middle bg-[#5A5F66]" />
              best (#{overlay.trialIdx}) overlaid
            </p>
          )}
          <div className="h-[160px]">
            <LinePlot
              title="brake torque vs RPM"
              xs={rpms}
              series={[
                ...(overlay
                  ? [{
                      label: "best",
                      xs: overlayRpms,
                      y: overlayPoints.map((p) => p.lastCycle.brakeTorqueNm),
                      color: "#5A5F66",
                      showPoints: false,
                    }]
                  : []),
                { label: "Nm", y: torque, color: "#FFC627", showPoints: true },
              ]}
              xLabel="rpm"
              yLabel="Nm"
              height={160}
            />
          </div>
          <div className="h-[160px]">
            <LinePlot
              title="brake power vs RPM"
              xs={rpms}
              series={[
                ...(overlay
                  ? [{
                      label: "best",
                      xs: overlayRpms,
                      y: overlayPoints.map((p) => p.lastCycle.brakePowerKW),
                      color: "#5A5F66",
                      showPoints: false,
                    }]
                  : []),
                { label: "kW", y: power, color: "#A5D6A7", showPoints: true },
              ]}
              xLabel="rpm"
              yLabel="kW"
              height={160}
            />
          </div>
          <div className="h-[160px]">
            <LinePlot
              title="IMEP vs RPM"
              xs={rpms}
              series={[
                ...(overlay
                  ? [{
                      label: "best",
                      xs: overlayRpms,
                      y: overlayPoints.map((p) => p.lastCycle.imepBar),
                      color: "#5A5F66",
                      showPoints: false,
                    }]
                  : []),
                { label: "bar", y: imep, color: "#4FC3F7", showPoints: true },
              ]}
              xLabel="rpm"
              yLabel="bar"
              height={160}
            />
          </div>
        </div>
      )}
    </div>
  );
}
