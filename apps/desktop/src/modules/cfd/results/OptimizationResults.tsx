// Top-level results screen for optimization studies. Left pane: header,
// parallel-coords plot, trial table. Right pane: TrialInspector for the
// currently-selected trial. Selecting via plot or table both flow through
// `selectedIdx` state. Best trial is highlighted amber in plot + table.

import { useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { basename } from "../lib/cfdPath";
import { ParallelCoordsPlot, type ParallelCoordsTrial } from "../components/charts/ParallelCoordsPlot";
import { TrialInspector } from "./TrialInspector";
import type { OptimizationStudy } from "../state/types";

interface Props {
  study: OptimizationStudy;
}

export function OptimizationResults({ study }: Props) {
  const { cancelStudy } = useCfd();
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const doneTrials = useMemo(
    () => study.trials.filter((t) => t.status === "done" && t.objectiveValue !== null),
    [study.trials],
  );

  // Axes: one per parameter path + final axis for the objective. We use
  // the actual data extent so the axes adapt as trials come in. If we
  // only have 0–1 trials the axes degenerate; the plot's safe-divide
  // guards handle that visually.
  const axes = useMemo(() => {
    const paramAxes = study.parameterPaths.map((p) => {
      const vals = doneTrials
        .map((t) => t.parameterValues[p])
        .filter((v): v is number => v !== undefined && Number.isFinite(v));
      const min = vals.length ? Math.min(...vals) : 0;
      const max = vals.length ? Math.max(...vals) : 1;
      return { label: p, min, max };
    });
    const objVals = doneTrials
      .map((t) => t.objectiveValue!)
      .filter((v) => Number.isFinite(v));
    const objMin = objVals.length ? Math.min(...objVals) : 0;
    const objMax = objVals.length ? Math.max(...objVals) : 1;
    return [
      ...paramAxes,
      { label: `objective (${study.objectiveDirection})`, min: objMin, max: objMax },
    ];
  }, [study.parameterPaths, study.objectiveDirection, doneTrials]);

  const trialsForPlot: ParallelCoordsTrial[] = useMemo(
    () =>
      doneTrials.map((t) => ({
        trialIdx: t.trialIdx,
        values: study.parameterPaths.map((p) => t.parameterValues[p] ?? Number.NaN),
        objective: t.objectiveValue!,
        bestTrial: study.bestTrialIdx === t.trialIdx,
      })),
    [doneTrials, study.parameterPaths, study.bestTrialIdx],
  );

  const selectedTrial =
    selectedIdx !== null
      ? study.trials.find((t) => t.trialIdx === selectedIdx)
      : null;

  const elapsed = ((study.finishedAt ?? Date.now()) - study.startedAt) / 1000;

  return (
    <div className="flex h-full flex-col bg-[#0B0B0D] text-[#D8DCE2]">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Optimization</div>
          <p className="text-[10px] text-[#5A5F66]">
            <span className="text-[#D8DCE2]">{basename(study.configPath)}</span>
            {" · "}
            {doneTrials.length}/{study.params.nTrials} trials done
            {study.bestTrialIdx !== null && study.bestObjectiveValue !== null && (
              <span className="ml-2 text-amber-300">
                best #{study.bestTrialIdx} = {study.bestObjectiveValue.toPrecision(5)}
              </span>
            )}
            <span className="ml-2">{elapsed.toFixed(1)} s</span>
          </p>
        </div>
        {study.status === "running" && (
          <button
            type="button"
            onClick={() => cancelStudy(study.id)}
            className="rounded-sm border border-red-500/40 px-2 py-1 text-[10px] uppercase tracking-wider text-red-300 hover:bg-red-500/10"
          >
            Cancel
          </button>
        )}
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-[1fr_360px] gap-3 overflow-hidden p-3">
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          {doneTrials.length === 0 ? (
            <div className="m-4 rounded-sm border border-dashed border-[#2A2C32] p-8 text-center text-[11px] text-[#5A5F66]">
              Waiting for first trial…
            </div>
          ) : (
            <div className="overflow-auto">
              <ParallelCoordsPlot
                axes={axes}
                trials={trialsForPlot}
                onTrialClick={setSelectedIdx}
                selectedTrialIdx={selectedIdx}
              />
            </div>
          )}

          <table className="w-full text-left font-mono text-[10px]">
            <thead className="bg-[#0B0B0D] text-[9px] uppercase tracking-wider text-[#5A5F66]">
              <tr className="border-b border-[#2A2C32] [&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
                <th>#</th>
                <th>status</th>
                <th className="text-right">obj</th>
                <th className="text-right">wall (s)</th>
                {study.parameterPaths.map((p) => (
                  <th key={p}>{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {study.trials.map((t) => {
                const isSelected = selectedIdx === t.trialIdx;
                const isBest = study.bestTrialIdx === t.trialIdx;
                const baseCls = isBest
                  ? "text-amber-300"
                  : t.status === "done"
                  ? "text-[#D8DCE2]"
                  : "text-[#5A5F66]";
                return (
                  <tr
                    key={t.trialIdx}
                    onClick={() => setSelectedIdx(t.trialIdx)}
                    className={
                      "cursor-pointer border-t border-[#16171B] " +
                      (isSelected ? "bg-[#16171B] " : "hover:bg-[#16171B]/50 ") +
                      baseCls
                    }
                  >
                    <td className="px-2 py-0.5">{t.trialIdx}</td>
                    <td className="px-2 py-0.5">{t.status}</td>
                    <td className="px-2 py-0.5 text-right">
                      {t.objectiveValue !== null ? t.objectiveValue.toPrecision(5) : "—"}
                    </td>
                    <td className="px-2 py-0.5 text-right">
                      {t.wallTimeS !== null ? t.wallTimeS.toFixed(2) : "—"}
                    </td>
                    {study.parameterPaths.map((p) => (
                      <td key={p} className="px-2 py-0.5">
                        {t.parameterValues[p] !== undefined
                          ? t.parameterValues[p]!.toPrecision(4)
                          : "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="min-h-0 overflow-auto rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-3">
          {selectedTrial ? (
            <TrialInspector
              trial={selectedTrial}
              parameterPaths={study.parameterPaths}
            />
          ) : (
            <p className="text-[11px] text-[#5A5F66]">Click a trial to inspect.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
