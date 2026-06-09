// Top-level results screen for optimization studies — the headline live view.
//
// Left pane: header (live best + ETA + elapsed + Cancel + ExportMenu), podium
// (top-3), charts (convergence + value-vs-parameter scatter + parallel-coords),
// a Rank-by control, and a sortable trial table. Right pane: TrialInspector.
//
// RANKING DIMENSION: the whole view ranks by one "active dimension" — the
// study's backend objective by default, or any FSAE event metric (accel /
// autocross / endurance time, endurance / efficiency / total points). Switching
// it feeds useOptimizationLive a study whose objectiveValue is remapped to that
// dimension, so the podium, every chart, and the table can never disagree.
// Event metrics are scored on the frontend (same computeEvents() lib as the
// Performance screen); since the backend sampler is space-filling, ranking by an
// event metric picks the best sampled design for that event.

import { useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { useOptimizationLive, useElapsedSeconds } from "../state/useOptimizationLive";
import { basename } from "../lib/cfdPath";
import { studyName, sweepFromTrialName, refineName } from "../lib/studyName";
import { StudyNameEditor } from "../components/StudyNameEditor";
import { objectiveUnit } from "../lib/metricMeta";
import { exportActionsFor } from "../lib/export/exportStudy";
import { buildTrialsTsv } from "../lib/export/buildCsv";
import { copyText } from "../lib/export/io";
import { ExportMenu, type ExportMenuItem } from "../components/ExportMenu";
import { ScatterPlot, type ScatterPt } from "../components/charts/ScatterPlot";
import { ParallelCoordsPlot, type ParallelCoordsTrial } from "../components/charts/ParallelCoordsPlot";
import { TornadoChart, type TornadoBar } from "../components/charts/TornadoChart";
import { sensitivityTornado, refineBounds } from "../lib/analytics/optimizationStats";
import {
  torqueCurveFromSweep,
  computeEvents,
  cachedTrialEvents,
  carKeyForConfig,
  vehicleForCar,
  EMPTY_BASELINE,
  EVENT_RANK_METRICS,
  POINTS_METRIC_KEYS,
  type EventScores,
  type EventMetricKey,
} from "../lib/performance";
import { TrialInspector } from "./TrialInspector";
import { SweepParamsModal } from "../components/SweepParamsModal";
import type { OptimizationStudy, OptimizationTrial, ParameterOverride } from "../state/types";

interface Props {
  study: OptimizationStudy;
}

type SortKey = "rank" | "obj" | "wall" | "trial" | string; // string => a param path
type SortDir = "asc" | "desc";

/** What the whole results view ranks by: the study's objective, or an event. */
type RankDim = "objective" | EventMetricKey;

const PODIUM: Record<number, { border: string; chip: string }> = {
  1: { border: "border-l-[#FFC627]", chip: "border-[#FFC627]/60 text-[#FFC627]" },
  2: { border: "border-l-[#C0C7D1]", chip: "border-[#C0C7D1]/60 text-[#C0C7D1]" },
  3: { border: "border-l-[#CD7F32]", chip: "border-[#CD7F32]/60 text-[#CD7F32]" },
};

const PODIUM_TEXT: Record<number, string> = {
  1: "text-[#FFC627]",
  2: "text-[#C0C7D1]",
  3: "text-[#CD7F32]",
};

/** Format ETA seconds as a coarse "~Xm est." / "~Xs est." string. */
function formatEta(seconds: number): string {
  if (seconds >= 90) return `~${Math.round(seconds / 60)}m est.`;
  return `~${Math.round(seconds)}s est.`;
}

export function OptimizationResults({ study }: Props) {
  const cfd = useCfd();
  const { cancelStudy, bridge, startSweep, startOptimization, renameStudy } = cfd;
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  // Trial whose recipe seeds the "run a sweep from this recipe" modal (null = closed).
  const [sweepSeedTrial, setSweepSeedTrial] = useState<OptimizationTrial | null>(null);
  const [paramForScatter, setParamForScatter] = useState<string>(
    study.parameterPaths[0] ?? "",
  );
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [rankDim, setRankDim] = useState<RankDim>(() => {
    const rb = study.params.rankBy;
    return rb && EVENT_RANK_METRICS.some((m) => m.key === rb) ? (rb as RankDim) : "objective";
  });
  const carKey = carKeyForConfig(study.configPath);

  // Per-trial FSAE event scores (frontend; same computeEvents() lib as the
  // Performance screen). Computed for ALL done trials so BOTH the active-dimension
  // re-rank AND the multi-objective "best design per objective" panel can read it.
  // Scores go through cachedTrialEvents (content-keyed, cross-render): trials are
  // immutable once done, so state-identity churn — a live trial landing, a
  // rehydrate, switching studies — only ever pays for trials not yet scored.
  // Without this, every churn re-simmed the WHOLE study and froze the app.
  const eventsByTrial = useMemo(() => {
    const map = new Map<number, EventScores>();
    const vehicle = vehicleForCar(carKey, cfd.state?.vehicleConfig);
    const baseline = cfd.state?.referenceBaseline ?? EMPTY_BASELINE;
    const ctxKey = `${JSON.stringify(vehicle)}|${JSON.stringify(baseline)}`;
    for (const t of study.trials) {
      const pts = t.sweepPoints;
      if (pts && pts.length > 0) {
        map.set(
          t.trialIdx,
          cachedTrialEvents(ctxKey, `${study.id}:${t.trialIdx}:${pts.length}`, () =>
            computeEvents(torqueCurveFromSweep(pts), vehicle, baseline),
          ),
        );
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.id, study.trials, carKey, cfd.state?.vehicleConfig, cfd.state?.referenceBaseline]);

  // Best trial for EACH objective (total points + each event), so the speed ↔
  // efficiency trade-off is visible at a glance: the total-points winner is the
  // balanced design, while the per-event winners show the extremes. One pick
  // jumps the whole view + inspector to that design.
  const bestByMetric = useMemo(() => {
    return EVENT_RANK_METRICS.map((m) => {
      let best: { val: number; trialIdx: number } | null = null;
      for (const t of study.trials) {
        const e = eventsByTrial.get(t.trialIdx);
        if (!e) continue;
        const val = m.get(e);
        if (val == null || !Number.isFinite(val)) continue;
        if (!best || (m.lowerBetter ? val < best.val : val > best.val)) {
          best = { val, trialIdx: t.trialIdx };
        }
      }
      return { metric: m, best };
    });
  }, [eventsByTrial, study.trials]);

  const dimDef = rankDim === "objective" ? null : EVENT_RANK_METRICS.find((m) => m.key === rankDim) ?? null;
  const objUnit = objectiveUnit(study.params.objective);
  const dim = dimDef
    ? { label: dimDef.label, unit: "", fmt: dimDef.fmt }
    : { label: "obj", unit: objUnit ?? "", fmt: (n: number) => n.toPrecision(5) };

  // The active ranking dimension drives the ENTIRE view (podium, charts, table)
  // by feeding useOptimizationLive a study whose objectiveValue is remapped to
  // that dimension — one source of truth, so nothing can disagree.
  const viewStudy: OptimizationStudy = useMemo(() => {
    if (!dimDef) return study;
    return {
      ...study,
      objectiveDirection: dimDef.lowerBetter ? "minimize" : "maximize",
      trials: study.trials.map((t) => {
        const e = eventsByTrial.get(t.trialIdx);
        return { ...t, objectiveValue: e ? dimDef.get(e) : null };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study, dimDef, eventsByTrial]);

  const live = useOptimizationLive(viewStudy);
  const elapsed = useElapsedSeconds(study);

  const isRunning = study.status === "running";
  const showEta = isRunning && live.nDone >= 3 && live.eta != null;

  // ---- Export menu items ---------------------------------------------------
  const exportItems: ExportMenuItem[] = useMemo(() => {
    const actions = exportActionsFor(study, {
      getSchema: (configPath) => bridge.getParameterSchema(configPath),
    });
    const fromAction = (label: string, run: () => Promise<string | null>): ExportMenuItem["run"] =>
      async () => {
        const path = await run();
        // null = user cancelled the save dialog. ExportMenu shows no toast for
        // an empty message; we surface "Cancelled" so the click feels acked.
        if (path == null) return { ok: true, message: "Cancelled" };
        const seg = path.split(/[\\/]/).pop() ?? path;
        return { ok: true, message: `Exported → ${seg}` };
      };

    const items: ExportMenuItem[] = actions.map((a) => ({
      id: a.id,
      label: a.label,
      run: fromAction(a.label, a.run),
    }));

    // Clipboard variants — not disk actions, so they live alongside the file
    // exports rather than in exportActionsFor.
    items.push({
      id: "opt-copy-tsv",
      label: "Copy table (TSV)",
      run: async () => {
        await copyText(buildTrialsTsv(study));
        return { ok: true, message: "Copied!" };
      },
    });
    items.push({
      id: "opt-copy-recipe",
      label: "Copy best recipe",
      run: async () => {
        const best = live.ranked[0]?.trial;
        if (!best) return { ok: false, message: "No best trial yet" };
        const lines = study.parameterPaths.map((p) => {
          const v = best.parameterValues[p];
          return `${p}\t${v !== undefined ? v : ""}`;
        });
        await copyText(lines.join("\n"));
        return { ok: true, message: "Copied!" };
      },
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study, bridge, live.ranked]);

  // ---- Charts: convergence + value-vs-parameter (all in the active dim) -----
  const convergencePoints: ScatterPt[] = useMemo(
    () =>
      live.done.map((t) => ({
        id: t.trialIdx,
        x: t.trialIdx,
        y: t.objectiveValue as number,
        rank: live.rankByIdx.get(t.trialIdx) ?? null,
      })),
    [live.done, live.rankByIdx],
  );

  const convergenceStep = useMemo(
    () => live.history.map((h) => ({ x: h.trialIdx, y: h.bestSoFar })),
    [live.history],
  );

  const paramScatterPoints: ScatterPt[] = useMemo(
    () =>
      live.done
        .filter((t) => Number.isFinite(t.parameterValues[paramForScatter]))
        .map((t) => ({
          id: t.trialIdx,
          x: t.parameterValues[paramForScatter] as number,
          y: t.objectiveValue as number,
          rank: live.rankByIdx.get(t.trialIdx) ?? null,
        })),
    [live.done, live.rankByIdx, paramForScatter],
  );

  // ---- Sensitivity tornado (Spearman ρ of each tunable vs the active dim) ---
  // Mined from the SAME view-remapped trials the rest of the screen ranks by,
  // so switching "Rank by" re-derives sensitivity in that dimension too. A bar
  // is "favorable" when raising the knob pushes the objective the better way.
  const sensitivityBars: TornadoBar[] = useMemo(() => {
    const maximize = viewStudy.objectiveDirection === "maximize";
    return sensitivityTornado(viewStudy.trials, study.parameterPaths).map((e) => ({
      label: e.path,
      value: e.rho,
      favorable: e.rho > 0 === maximize,
      n: e.n,
    }));
  }, [viewStudy.trials, viewStudy.objectiveDirection, study.parameterPaths]);

  // ---- Parallel-coords plot ------------------------------------------------
  const axes = useMemo(() => {
    const paramAxes = study.parameterPaths.map((p) => {
      const vals = live.done
        .map((t) => t.parameterValues[p])
        .filter((v): v is number => v !== undefined && Number.isFinite(v));
      const min = vals.length ? Math.min(...vals) : 0;
      const max = vals.length ? Math.max(...vals) : 1;
      return { label: p, min, max };
    });
    const objVals = live.done
      .map((t) => t.objectiveValue!)
      .filter((v) => Number.isFinite(v));
    const objMin = objVals.length ? Math.min(...objVals) : 0;
    const objMax = objVals.length ? Math.max(...objVals) : 1;
    return [
      ...paramAxes,
      { label: `${dim.label} (${viewStudy.objectiveDirection})`, min: objMin, max: objMax },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.parameterPaths, viewStudy.objectiveDirection, dim.label, live.done]);

  const trialsForPlot: ParallelCoordsTrial[] = useMemo(
    () =>
      live.done.map((t) => ({
        trialIdx: t.trialIdx,
        values: study.parameterPaths.map((p) => t.parameterValues[p] ?? Number.NaN),
        objective: t.objectiveValue!,
        rank: live.rankByIdx.get(t.trialIdx) ?? null,
      })),
    [live.done, study.parameterPaths, live.rankByIdx],
  );

  // ---- Sortable trial table (iterates the remapped view so the obj column,
  // ranks and deltas all reflect the active dimension) -----------------------
  const sortedTrials = useMemo(() => {
    const arr = [...viewStudy.trials];
    const rankOf = (t: OptimizationTrial) =>
      live.rankByIdx.get(t.trialIdx) ?? Number.POSITIVE_INFINITY;
    // The sorted quantity for a trial, or null when the trial doesn't carry it.
    // Rows WITHOUT the quantity always partition to the BOTTOM regardless of
    // asc/desc — otherwise an ascending sort floats empty "—" rows to the top.
    const valueOf = (t: OptimizationTrial): number | null => {
      if (sortKey === "rank") return Number.isFinite(rankOf(t)) ? rankOf(t) : null;
      if (sortKey === "obj") return t.objectiveValue;
      if (sortKey === "wall") return t.wallTimeS;
      if (sortKey === "trial") return t.trialIdx;
      return t.parameterValues[sortKey] ?? null;
    };
    const cmp = (a: OptimizationTrial, b: OptimizationTrial): number => {
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av == null || bv == null) {
        if (av == null && bv == null) return a.trialIdx - b.trialIdx;
        return av == null ? 1 : -1; // missing → last, in either direction
      }
      let d = av - bv;
      if (d === 0) d = a.trialIdx - b.trialIdx;
      return sortDir === "asc" ? d : -d;
    };
    return arr.sort(cmp);
  }, [viewStudy.trials, live.rankByIdx, sortKey, sortDir]);

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "rank" || key === "trial" ? "asc" : "desc");
    }
  }

  const arrow = (key: SortKey) =>
    key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  // ---- Selected trial (right pane) -----------------------------------------
  // Sourced from viewStudy so its objectiveValue is in the active dimension —
  // the inspector's headline value then agrees with the podium/table (its
  // sweepPoints are preserved through the remap for the per-RPM curves).
  const selectedTrial =
    selectedIdx !== null
      ? viewStudy.trials.find((t) => t.trialIdx === selectedIdx) ?? null
      : null;
  const selectedRanked =
    selectedIdx !== null
      ? live.ranked.find((r) => r.trial.trialIdx === selectedIdx) ?? null
      : null;
  const bestTrial = live.ranked[0]?.trial ?? null;

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="group min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Optimization</div>
          <p className="text-[10px] text-[#5A5F66]">
            <StudyNameEditor
              display={studyName(study)}
              customName={study.name}
              onRename={(name) => renameStudy(study.id, name)}
              className="text-[#D8DCE2]"
            />
            {study.name && <span className="ml-1">({basename(study.configPath)})</span>}
            {" · "}
            {live.nDone}/{study.params.nTrials} trials done
            {live.ranked[0] && (
              <span className="ml-2 text-amber-300">
                best #{live.ranked[0].trial.trialIdx} ={" "}
                {dim.fmt(live.ranked[0].trial.objectiveValue as number)}
                {dim.unit && <span className="ml-0.5 text-[#9097A0]">{dim.unit}</span>}
              </span>
            )}
            {showEta && (
              <span className="ml-2 text-[#9097A0]">{formatEta(live.eta as number)}</span>
            )}
            <span className="ml-2">{elapsed.toFixed(1)} s</span>
          </p>
        </div>
        <ExportMenu items={exportItems} />
        {isRunning && (
          <button
            type="button"
            onClick={() => cancelStudy(study.id)}
            className="rounded-sm border border-red-500/40 px-2 py-1 text-[10px] uppercase tracking-wider text-red-300 hover:bg-red-500/10"
          >
            Cancel
          </button>
        )}
      </header>

      {/* The grid IS the single scroll container: the left column flows to its
          full height and scrolls the whole page, while the inspector sticks in
          view. No nested mini-scrollers fighting for screen height. */}
      <div className="grid flex-1 min-h-0 grid-cols-[minmax(0,1fr)_360px] items-start gap-3 overflow-y-auto p-3">
        <div className="flex min-w-0 flex-col gap-3">
          {/* Podium row — 3 cards, fills in rank order; dashed placeholders. */}
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((slot) => {
              const r = live.top3[slot];
              if (!r) {
                return (
                  <div
                    key={slot}
                    className="flex h-[64px] items-center justify-center rounded-sm border border-dashed border-[#2A2C32] text-[18px] text-[#3A3D44]"
                  >
                    —
                  </div>
                );
              }
              const t = r.trial;
              const podium = PODIUM[r.rank]!;
              const selected = selectedIdx === t.trialIdx;
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => setSelectedIdx(t.trialIdx)}
                  className={
                    "flex flex-col rounded-sm border border-l-4 border-[#2A2C32] bg-[#0E0E10] px-2 py-1.5 text-left " +
                    podium.border +
                    (selected ? " ring-1 ring-[#FFC627]/40" : " hover:bg-[#16171B]")
                  }
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={
                        "rounded-sm border px-1 py-[1px] text-[9px] uppercase tracking-wider " +
                        podium.chip
                      }
                    >
                      #{r.rank}
                    </span>
                    <span className="text-[9px] text-[#5A5F66]">trial #{t.trialIdx}</span>
                  </div>
                  <div className="mt-1 font-mono text-[14px] text-[#D8DCE2]">
                    {dim.fmt(t.objectiveValue as number)}
                    {dim.unit && <span className="ml-1 text-[10px] text-[#9097A0]">{dim.unit}</span>}
                  </div>
                  <div className="font-mono text-[9px] text-[#5A5F66]">
                    {r.rank === 1
                      ? "best"
                      : `Δ ${r.deltaToBest > 0 ? "+" : ""}${r.deltaToBest.toPrecision(3)}` +
                        (r.pctOfBest != null
                          ? ` (${r.pctOfBest > 0 ? "+" : ""}${r.pctOfBest.toFixed(1)}%)`
                          : "")}
                    {t.wallTimeS !== null && <span className="ml-2">{t.wallTimeS.toFixed(1)} s</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Best design per OBJECTIVE — the efficiency ↔ speed trade-off at a
              glance. "total pts" is the balanced pick; the per-event winners are
              the extremes. Click any to inspect that design + rank the view by it. */}
          {bestByMetric.some((b) => b.best) && (
            <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
                Best design per objective
                <span className="ml-2 text-[9px] lowercase text-[#5A5F66]">
                  total pts = the efficiency↔speed balance · click to inspect + rank by it
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 p-2 font-mono text-[10px] sm:grid-cols-3">
                {bestByMetric.map(({ metric, best }) => (
                  <button
                    key={metric.key}
                    type="button"
                    disabled={!best}
                    onClick={() => {
                      if (!best) return;
                      setSelectedIdx(best.trialIdx);
                      setRankDim(metric.key);
                    }}
                    className={
                      "flex items-baseline justify-between gap-2 rounded-sm border px-1.5 py-1 text-left " +
                      (rankDim === metric.key
                        ? "border-[#FFC627]/60 bg-[#FFC627]/5"
                        : "border-[#2A2C32] hover:border-[#FFC627]/40") +
                      (best ? "" : " opacity-40")
                    }
                  >
                    <span className="uppercase tracking-wider text-[#5A5F66]">{metric.label}</span>
                    {best ? (
                      <span className="text-[#D8DCE2]">
                        {metric.fmt(best.val)} <span className="text-[#5A5F66]">#{best.trialIdx}</span>
                      </span>
                    ) : (
                      <span className="text-[#5A5F66]">—</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {live.nDone === 0 ? (
            <div className="m-4 rounded-sm border border-dashed border-[#2A2C32] p-8 text-center text-[11px] text-[#5A5F66]">
              {dimDef && POINTS_METRIC_KEYS.includes(dimDef.key)
                ? "No ranked trials — points need a reference baseline (set it on the Performance tab), or no trials are done yet."
                : "Waiting for first trial…"}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Convergence — full width, in the active dimension. */}
              <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <ScatterPlot
                  title={`${dim.label} vs trial`}
                  points={convergencePoints}
                  xLabel="trial"
                  yLabel={dim.label}
                  stepLine={convergenceStep}
                  selectedId={selectedIdx}
                  onPointClick={setSelectedIdx}
                  height={360}
                />
              </div>

              {/* Value vs parameter — full width, with a param selector. */}
              <div className="flex flex-col rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <div className="flex flex-wrap items-center gap-1 border-b border-[#2A2C32] px-2 py-1">
                  {study.parameterPaths.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setParamForScatter(p)}
                      className={
                        "rounded-sm border px-1.5 py-0.5 text-[9px] " +
                        (p === paramForScatter
                          ? "border-[#FFC627] text-[#FFC627]"
                          : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]/60")
                      }
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <ScatterPlot
                  title={`${dim.label} vs ${paramForScatter}`}
                  points={paramScatterPoints}
                  xLabel={paramForScatter}
                  yLabel={dim.label}
                  selectedId={selectedIdx}
                  onPointClick={setSelectedIdx}
                  height={360}
                />
              </div>

              {/* Sensitivity tornado — which knobs move the active dimension. */}
              <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <TornadoChart
                  title={`sensitivity · ${dim.label}`}
                  bars={sensitivityBars}
                  axisLabel={`Spearman ρ vs ${dim.label} (${
                    viewStudy.objectiveDirection === "maximize" ? "higher" : "lower"
                  } better)`}
                  selectedLabel={paramForScatter}
                  onBarClick={setParamForScatter}
                />
              </div>

              {/* Parallel coordinates — full width. */}
              <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
                  parallel coordinates
                </div>
                <ParallelCoordsPlot
                  axes={axes}
                  trials={trialsForPlot}
                  onTrialClick={setSelectedIdx}
                  selectedTrialIdx={selectedIdx}
                  height={420}
                />
              </div>
            </div>
          )}

          {/* Rank-by control — the active dimension drives the whole view. */}
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className="uppercase tracking-wider text-[#9097A0]">Rank by</span>
            <select
              aria-label="Rank by"
              value={rankDim}
              onChange={(e) => setRankDim(e.target.value as RankDim)}
              className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
            >
              <option value="objective">objective ({study.params.objective.metric})</option>
              {EVENT_RANK_METRICS.map((m) => (
                <option key={m.key} value={m.key}>
                  event · {m.label}
                </option>
              ))}
            </select>
            {dimDef && (
              <span className="text-[#5A5F66]">
                podium + charts + table all rank by {dimDef.label} · vehicle {carKey}
                {POINTS_METRIC_KEYS.includes(dimDef.key) ? " · needs baselines (Performance tab)" : ""}
              </span>
            )}
            {/* Actually optimize FOR the active metric: re-sample in a narrowed
                box around the current #1, concentrating the search where the
                score is highest (iterative refinement on the space-filling
                backend). Each click converges further on that objective. */}
            <button
              type="button"
              disabled={!live.ranked[0] || study.status === "running"}
              title={`Start a new optimization that narrows the parameter search around the current #1 (best ${dim.label}) — concentrates the sampler there to push that objective further.`}
              onClick={() => {
                const best = live.ranked[0]?.trial;
                if (!best) return;
                void startOptimization(study.configPath, {
                  ...study.params,
                  tunables: refineBounds(study.params.tunables, best.parameterValues, 0.3),
                  seed: null,
                  rankBy: rankDim === "objective" ? study.params.rankBy ?? null : rankDim,
                }, { name: refineName(study.configPath, best.trialIdx) });
              }}
              className="rounded-sm border border-[#FFC627]/50 px-2 py-1 text-[10px] uppercase tracking-wider text-[#FFC627] hover:bg-[#FFC627]/10 disabled:opacity-40"
            >
              ⟲ Refine around #1
            </button>
          </div>

          {/* Sortable ranked trial table. */}
          <div className="overflow-x-auto rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
            <table className="w-full text-left font-mono text-[10px]">
              <thead className="bg-[#0B0B0D] text-[9px] uppercase tracking-wider text-[#5A5F66]">
                <tr className="border-b border-[#2A2C32] [&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
                  <SortTh label="rank" k="rank" onSort={onSort} arrow={arrow} />
                  <SortTh label="#" k="trial" onSort={onSort} arrow={arrow} />
                  <th>status</th>
                  <SortTh label={dim.label} k="obj" align="right" onSort={onSort} arrow={arrow} />
                  <th className="text-right">Δ best</th>
                  <SortTh label="wall (s)" k="wall" align="right" onSort={onSort} arrow={arrow} />
                  {study.parameterPaths.map((p) => (
                    <SortTh key={p} label={p} k={p} onSort={onSort} arrow={arrow} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedTrials.map((t) => {
                  const isSelected = selectedIdx === t.trialIdx;
                  const rank = live.rankByIdx.get(t.trialIdx) ?? null;
                  const rankedRow = live.ranked.find((r) => r.trial.trialIdx === t.trialIdx);
                  const podiumText = rank != null ? PODIUM_TEXT[rank] : undefined;
                  const baseCls = podiumText
                    ? podiumText
                    : t.status === "done"
                    ? "text-[#D8DCE2]"
                    : "text-[#5A5F66]";
                  return (
                    <tr
                      key={t.trialIdx}
                      onClick={() => setSelectedIdx(t.trialIdx)}
                      // Rows select the inspected trial — make that reachable
                      // and operable by keyboard, not just pointer.
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedIdx(t.trialIdx);
                        }
                      }}
                      className={
                        "cursor-pointer border-t border-[#16171B] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#FFC627]/60 " +
                        (isSelected ? "bg-[#16171B] " : "hover:bg-[#16171B]/50 ") +
                        baseCls
                      }
                    >
                      <td className="px-2 py-0.5">{rank ?? "—"}</td>
                      <td className="px-2 py-0.5">{t.trialIdx}</td>
                      <td className="px-2 py-0.5">
                        {t.status === "running" ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#FFC627]" />
                            running
                          </span>
                        ) : (
                          t.status
                        )}
                      </td>
                      <td className="px-2 py-0.5 text-right">
                        {t.objectiveValue !== null ? dim.fmt(t.objectiveValue) : "—"}
                      </td>
                      <td className="px-2 py-0.5 text-right">
                        {rankedRow
                          ? rankedRow.rank === 1
                            ? "best"
                            : `${rankedRow.deltaToBest > 0 ? "+" : ""}${rankedRow.deltaToBest.toPrecision(3)}`
                          : "—"}
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
        </div>

        <aside className="sticky top-0 self-start max-h-[calc(100vh-7rem)] overflow-auto rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-3">
          {selectedTrial ? (
            <TrialInspector
              trial={selectedTrial}
              parameterPaths={study.parameterPaths}
              configPath={study.configPath}
              dim={dim}
              rank={selectedRanked?.rank ?? null}
              deltaToBest={selectedRanked?.deltaToBest ?? null}
              pctOfBest={selectedRanked?.pctOfBest ?? null}
              bestTrial={bestTrial}
              onRunSweep={
                selectedTrial && Object.keys(selectedTrial.parameterValues).length > 0
                  ? () => setSweepSeedTrial(selectedTrial)
                  : undefined
              }
            />
          ) : (
            <p className="text-[11px] text-[#5A5F66]">Click a trial to inspect.</p>
          )}
        </aside>
      </div>

      {sweepSeedTrial && (
        <SweepParamsModal
          open
          defaultPath={study.configPath}
          seedLabel={`trial #${sweepSeedTrial.trialIdx}`}
          seedOverrides={Object.entries(sweepSeedTrial.parameterValues).map(
            ([path, value]): ParameterOverride => ({ path, value }),
          )}
          onCancel={() => setSweepSeedTrial(null)}
          onStart={async (params) => {
            // Provenance name: "sdm26 — opt #12 recipe", not a third study
            // that just says "sdm26.json".
            await startSweep(study.configPath, params, {
              name: sweepFromTrialName(study.configPath, sweepSeedTrial.trialIdx),
            });
            setSweepSeedTrial(null);
          }}
        />
      )}
    </div>
  );
}

/** Sortable header cell — clickable, shows the active-sort arrow glyph. */
function SortTh({
  label,
  k,
  align,
  onSort,
  arrow,
}: {
  label: string;
  k: SortKey;
  align?: "right";
  onSort: (k: SortKey) => void;
  arrow: (k: SortKey) => string;
}) {
  return (
    <th className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className="cursor-pointer uppercase tracking-wider text-[#5A5F66] hover:text-[#FFC627]"
      >
        {label}
        {arrow(k)}
      </button>
    </th>
  );
}
