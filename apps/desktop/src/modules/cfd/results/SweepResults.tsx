// Sweep results screen: per-RPM curves, a roll-up summary band, the per-RPM
// table, expandable capture rows + wave viewer, and an overlay-compare strip.
//
// Analytics + export grafts (v1): a summary band above the charts (peaks +
// powerband, with interpolated rpm marked "~"), a brake-torque-vs-RPM chart,
// a knock-integral-vs-RPM chart (only when ≥1 point carries knockIntegral), an
// ExportMenu in the header (per-RPM CSV / Cycles CSV / Study JSON + Copy
// summary), and τ_brake / KI columns in the table. The summary numbers come
// from summarizeSweep(); the band's Copy button and the menu's "Copy summary"
// both build the same one-line text via copyText.

import { Fragment, useMemo, useState } from "react";

import { LinePlot } from "../components/charts/LinePlot";
import { ExportMenu, type ExportMenuItem } from "../components/ExportMenu";
import { PvLoopView } from "./PvLoopView";
import { PipeProfileView } from "./PipeProfileView";
import { WaveViewerModal } from "./wave-viewer";
import { useCfd } from "../state/CfdContext";
import { basename } from "../lib/cfdPath";
import { studyName } from "../lib/studyName";
import { StudyNameEditor } from "../components/StudyNameEditor";
import { ReportButton } from "../components/ReportButton";
import { summarizeSweep, type PeakInfo, type SweepSummary } from "../lib/analytics/sweepStats";
import { exportActionsFor, type ExportAction } from "../lib/export/exportStudy";
import { copyText, openTextFile } from "../lib/export/io";
import { parseDynoCsv, dynoPowerKw, dynoTorqueNm } from "../lib/import/importDyno";
import { compareDyno } from "../lib/analytics/dynoCompare";
import type { SweepStudy } from "../state/types";

interface Props {
  study: SweepStudy;
}

/** Round-to-int rpm with a thousands separator, e.g. 11480 → "11,480". */
function fmtRpm(rpm: number): string {
  return Math.round(rpm).toLocaleString();
}

/** A peak phrase: "64.2 kW @ 11,480" — the rpm gets a leading "~" when the
 *  parabolic-vertex estimate moved off the sampled point (interpolated). */
function peakPhrase(peak: PeakInfo, unit: string, valueDecimals: number): string {
  const interp = peak.rpmInterp !== peak.rpm;
  const rpmStr = (interp ? "~" : "") + fmtRpm(peak.rpmInterp);
  return `${peak.valueInterp.toFixed(valueDecimals)} ${unit} @ ${rpmStr}`;
}

/** Build the one-line summary string shared by the band Copy button and the
 *  ExportMenu "Copy summary" item. Mirrors the on-screen band. */
function summaryLine(summary: SweepSummary): string {
  const parts: string[] = [];
  if (summary.peakPower) parts.push(`Peak P ${peakPhrase(summary.peakPower, "kW", 1)}`);
  if (summary.peakTorque) parts.push(`Peak τ ${peakPhrase(summary.peakTorque, "Nm", 1)}`);
  if (summary.peakVe) {
    const interp = summary.peakVe.rpmInterp !== summary.peakVe.rpm;
    const rpmStr = (interp ? "~" : "") + fmtRpm(summary.peakVe.rpmInterp);
    parts.push(`Peak VE ${(summary.peakVe.valueInterp * 100).toFixed(1)}% @ ${rpmStr}`);
  }
  if (summary.powerband) {
    const { fromRpm, toRpm, widthRpm } = summary.powerband;
    parts.push(`Powerband ${fmtRpm(fromRpm)}–${fmtRpm(toRpm)} (${fmtRpm(widthRpm)})`);
  }
  if (summary.maxKnockIntegral != null) {
    parts.push(`KI max ${summary.maxKnockIntegral.toFixed(2)}`);
  }
  return parts.join(" · ");
}

export function SweepResults({ study }: Props) {
  const { state, cancelStudy, setSweepCompare, setSweepDynoRef, renameStudy, bridge } = useCfd();
  const [dynoError, setDynoError] = useState<string | null>(null);
  const [dynoWarn, setDynoWarn] = useState<string | null>(null);
  const [expandedRpm, setExpandedRpm] = useState<number | null>(null);
  const [waveViewerRpm, setWaveViewerRpm] = useState<number | null>(null);

  const sweepCapturedRpms = useMemo(
    () =>
      (study.points ?? [])
        .filter((p) => p.captureDir != null)
        .map((p) => Math.round(p.rpm)),
    [study.points],
  );

  const compare = useMemo(() => {
    if (!study.compareWithStudyId) return null;
    const s = state.studies[study.compareWithStudyId];
    if (!s || s.kind !== "sweep") return null;
    return s as SweepStudy;
  }, [study.compareWithStudyId, state.studies]);

  const otherSweeps = useMemo(
    () => Object.values(state.studies).filter(
      (s): s is SweepStudy => s.kind === "sweep" && s.id !== study.id,
    ),
    [state.studies, study.id],
  );

  const elapsed = useMemo(() => {
    const end = study.finishedAt ?? Date.now();
    return ((end - study.startedAt) / 1000).toFixed(1);
  }, [study.finishedAt, study.startedAt]);

  const captureBadge =
    study.params.capturePvLoops || study.params.capturePipeProfiles || study.params.captureWaves;

  // Sort points by RPM (events arrive in order but be defensive).
  const points = useMemo(
    () => [...study.points].sort((a, b) => a.rpm - b.rpm),
    [study.points],
  );
  const comparePoints = useMemo(
    () => compare ? [...compare.points].sort((a, b) => a.rpm - b.rpm) : [],
    [compare],
  );

  // Roll-up summary (peaks, powerband, KI). Shown once ≥2 points exist.
  const summary = useMemo(() => summarizeSweep(points), [points]);

  // Dyno reference overlay: imported CSV points + on-screen RMSE/bias vs the
  // sim's WHEEL power — a chassis dyno measures downstream of the driveline,
  // so comparing it against brake (crank) power overstated the sim by the
  // drivetrain loss (~15%). Same wheel-vs-wheel convention as the
  // physics_findings dyno calibration. Power/torque derive from each other
  // when one is absent (P = tau*omega).
  const dyno = study.dynoRef ?? null;
  const dynoCmp = useMemo(() => {
    if (!dyno) return null;
    const sim = points.map((p) => ({ rpm: p.rpm, powerKw: p.lastCycle.wheelPowerKW }));
    return compareDyno(sim, dyno.points);
  }, [dyno, points]);
  const dynoPowerSeries = useMemo(() => {
    if (!dyno) return null;
    const pts = dyno.points
      .map((d) => ({ rpm: d.rpm, v: dynoPowerKw(d) }))
      .filter((d): d is { rpm: number; v: number } => d.v != null);
    return pts.length ? pts : null;
  }, [dyno]);
  const dynoTorqueSeries = useMemo(() => {
    if (!dyno) return null;
    const pts = dyno.points
      .map((d) => ({ rpm: d.rpm, v: dynoTorqueNm(d) }))
      .filter((d): d is { rpm: number; v: number } => d.v != null);
    return pts.length ? pts : null;
  }, [dyno]);

  async function importDynoCsv() {
    setDynoError(null);
    setDynoWarn(null);
    try {
      const picked = await openTextFile("csv");
      if (!picked) return;
      const label = picked.path.split(/[\\/]/).pop() ?? picked.path;
      const ref = parseDynoCsv(picked.contents, label);
      setSweepDynoRef(study.id, ref);
      // Non-fatal: rows with a valid rpm but no usable power/torque were
      // dropped (e.g. an unhandled locale/number format) — flag it so the
      // import isn't silently incomplete.
      if (ref.skippedRows) {
        setDynoWarn(`Imported ${ref.points.length} points; skipped ${ref.skippedRows} row${ref.skippedRows === 1 ? "" : "s"} with no usable power/torque.`);
      }
    } catch (err) {
      setDynoError(err instanceof Error ? err.message : String(err));
    }
  }

  const showSummary = points.length >= 2;
  const hasKnock = summary.maxKnockIntegral != null;

  // ExportMenu items: the per-kind export actions + a "Copy summary" item.
  // Adapt each ExportAction → ExportMenuItem: a written path becomes an
  // "Exported → <file>" toast, a cancelled save (null) a "Cancelled" toast
  // (ExportMenu shows a box even for an empty message, so don't emit one),
  // a throw an error toast.
  const exportItems = useMemo<ExportMenuItem[]>(() => {
    const actions: ExportAction[] = exportActionsFor(study);
    const fromActions: ExportMenuItem[] = actions.map((a) => ({
      id: a.id,
      label: a.label,
      run: async () => {
        try {
          const path = await a.run();
          if (path == null) return { ok: true, message: "Cancelled" };
          return { ok: true, message: `Exported → ${basename(path)}` };
        } catch (err) {
          return { ok: false, message: String(err) };
        }
      },
    }));
    fromActions.push({
      id: "sweep-copy-summary",
      label: "Copy summary",
      run: async () => {
        try {
          await copyText(summaryLine(summary));
          return { ok: true, message: "Copied!" };
        } catch (err) {
          return { ok: false, message: String(err) };
        }
      },
    });
    return fromActions;
  }, [study, summary]);

  async function copySummary() {
    try {
      await copyText(summaryLine(summary));
    } catch {
      // Clipboard failures are non-fatal here; the menu item surfaces a toast.
    }
  }

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[11px] uppercase tracking-wider text-[#9097A0]">
            <span className="text-[#FFC627]">Sweep</span>
            <span>·</span>
            <span>{study.params.rpmList.length} rpm</span>
            <span>·</span>
            <span>{study.params.junctionKind}</span>
            <StatusBadge status={study.status} />
            {captureBadge && (
              <span className="ml-1 rounded-sm border border-[#FFC627]/40 px-1.5 py-[1px] text-[9px] text-[#FFC627]" title="Captures enabled">
                capture
              </span>
            )}
          </div>
          <div className="group mt-0.5 truncate text-[10px] text-[#5A5F66]" title={study.configPath}>
            <StudyNameEditor
              display={studyName(study)}
              customName={study.name}
              onRename={(name) => renameStudy(study.id, name)}
              className="text-[#9097A0]"
            />
            {study.name && <span className="ml-1">({basename(study.configPath)})</span>}
            {" "}· {points.length}/{study.params.rpmList.length} rpm · {elapsed}s
            {study.summary && (
              <> · {study.summary.totalStepCount.toLocaleString()} steps · {study.summary.totalWallTimeS.toFixed(1)}s solver</>
            )}
          </div>
          {study.error && (
            <div className="mt-0.5 text-[10px] text-red-300" role="alert">
              {study.errorReason ? `${study.errorReason}: ` : ""}{study.error}
            </div>
          )}
        </div>
        <ReportButton defaultOnly={[study.id]} />
        <ExportMenu items={exportItems} />
        {study.status === "running" && (
          <button type="button"
            className="rounded-sm border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] uppercase tracking-wider text-red-200 hover:bg-red-500/20"
            onClick={() => cancelStudy(study.id)}
          >
            Cancel
          </button>
        )}
      </header>

      {/* Compare picker — higher-contrast strip so it's actually visible */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[#2A2C32] bg-[#16171B] px-3 py-2 text-[11px] text-[#D8DCE2]">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">Overlay</span>
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Compare to</span>
        <select
          aria-label="Compare to"
          className="rounded-sm border border-[#FFC627]/40 bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] hover:border-[#FFC627] focus:border-[#FFC627] focus:outline-none"
          value={study.compareWithStudyId ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setSweepCompare(study.id, v ? v : undefined);
          }}
        >
          <option value="">(none — no overlay)</option>
          {otherSweeps.map((s) => (
            <option key={s.id} value={s.id}>
              {studyName(s)} · {s.params.rpmList.length} rpm · {s.params.junctionKind} · {new Date(s.startedAt).toLocaleTimeString()}
            </option>
          ))}
        </select>
        {compare ? (
          <span className="flex items-center gap-1 text-[10px] text-[#9097A0]">
            <span className="inline-block h-[2px] w-3 bg-[#8A8F96]" />
            <span>{basename(compare.configPath)} ({compare.params.junctionKind})</span>
          </span>
        ) : otherSweeps.length === 0 ? (
          <span className="text-[10px] text-[#5A5F66]">Run another sweep to enable overlay comparison.</span>
        ) : (
          <span className="text-[10px] text-[#5A5F66]">{otherSweeps.length} sweep{otherSweeps.length === 1 ? "" : "s"} available to overlay.</span>
        )}

        {/* Dyno reference: import → overlay + RMSE/bias readout (sim − dyno). */}
        <span className="mx-1 h-4 w-px bg-[#2A2C32]" aria-hidden />
        <button
          type="button"
          onClick={() => void importDynoCsv()}
          className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
        >
          {dyno ? "Replace dyno CSV…" : "Import dyno CSV…"}
        </button>
        {dyno && (
          <span className="flex items-center gap-1.5 text-[10px] text-[#9097A0]">
            <span className="inline-block h-[2px] w-3 bg-[#CE93D8]" aria-hidden />
            <span className="text-[#CE93D8]">{dyno.label}</span>
            {dynoCmp ? (
              <span
                className="rounded-sm border border-[#CE93D8]/40 px-1.5 py-[1px] tabular-nums"
                title="Wheel power, sim − dyno, over the overlapping RPM band. Positive bias = the sim over-predicts."
              >
                RMSE {dynoCmp.rmseKw.toFixed(2)} kW · bias {dynoCmp.biasKw >= 0 ? "+" : ""}
                {dynoCmp.biasKw.toFixed(2)} kW · {dynoCmp.n} pts {fmtRpm(dynoCmp.rpmMin)}–{fmtRpm(dynoCmp.rpmMax)}
              </span>
            ) : (
              <span className="text-[#5A5F66]">no overlapping RPM band yet</span>
            )}
            <button
              type="button"
              aria-label={`Remove dyno reference ${dyno.label}`}
              onClick={() => setSweepDynoRef(study.id, undefined)}
              className="rounded-sm border border-[#2A2C32] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66] hover:border-[#FF5252] hover:text-[#FF5252]"
            >
              remove
            </button>
          </span>
        )}
        {dynoError && (
          <span role="alert" className="text-[10px] text-red-300">
            {dynoError}
          </span>
        )}
        {!dynoError && dynoWarn && (
          <span role="status" className="text-[10px] text-amber-300">
            {dynoWarn}
          </span>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {points.length === 0 ? (
          <div className="m-6 rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-8 text-center text-[11px] text-[#5A5F66]">
            {study.status === "running"
              ? "Waiting for the first RPM to finish…"
              : "No RPMs completed."}
          </div>
        ) : (
          <>
            {/* Summary band — peaks + powerband, interpolated rpm marked "~". */}
            {showSummary && (
              <section
                className="m-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-[#2A2C32] bg-[#0E0E10] px-3 py-2 text-[11px] text-[#D8DCE2]"
                aria-label="Sweep summary"
              >
                {summary.peakPower && (
                  <SummaryStat label="Peak P">{peakPhrase(summary.peakPower, "kW", 1)}</SummaryStat>
                )}
                {summary.peakTorque && (
                  <SummaryStat label="Peak τ">{peakPhrase(summary.peakTorque, "Nm", 1)}</SummaryStat>
                )}
                {summary.peakVe && (
                  <SummaryStat label="Peak VE">
                    {(summary.peakVe.valueInterp * 100).toFixed(1)}% @{" "}
                    {(summary.peakVe.rpmInterp !== summary.peakVe.rpm ? "~" : "") + fmtRpm(summary.peakVe.rpmInterp)}
                  </SummaryStat>
                )}
                {summary.powerband && (
                  <SummaryStat label="Powerband">
                    {fmtRpm(summary.powerband.fromRpm)}–{fmtRpm(summary.powerband.toRpm)} ({fmtRpm(summary.powerband.widthRpm)})
                  </SummaryStat>
                )}
                {summary.maxKnockIntegral != null && (
                  <span
                    className="rounded-sm border border-[#FF8A65]/50 px-1.5 py-[1px] text-[10px] text-[#FF8A65]"
                    title="Max Livengood-Wu knock integral over the sweep"
                  >
                    KI max {summary.maxKnockIntegral.toFixed(2)}
                  </span>
                )}
                <button
                  type="button"
                  className="ml-auto rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
                  onClick={() => void copySummary()}
                >
                  Copy
                </button>
              </section>
            )}

            {/* Curves — stacked full-width so each is large and the whole page scrolls. */}
            <div className="grid grid-cols-1 gap-2 p-2">
              <ChartCard>
                <LinePlot
                  title="IMEP / BMEP / FMEP (bar) vs RPM"
                  xs={points.map((p) => p.rpm)}
                  series={[
                    { label: "IMEP", y: points.map((p) => p.lastCycle.imepBar), color: "#FFC627", showPoints: true },
                    { label: "BMEP", y: points.map((p) => p.lastCycle.bmepBar), color: "#A5D6A7", showPoints: true },
                    { label: "FMEP", y: points.map((p) => p.lastCycle.fmepBar), color: "#FF8A65", showPoints: true },
                    ...(compare ? [
                      { label: "IMEP (cmp)", xs: comparePoints.map((p) => p.rpm), y: comparePoints.map((p) => p.lastCycle.imepBar), color: "#5A5F66", showPoints: false },
                    ] : []),
                  ]}
                  xLabel="rpm" yLabel="bar" height={340}
                />
              </ChartCard>
              <ChartCard>
                <LinePlot
                  title="VE vs RPM"
                  xs={points.map((p) => p.rpm)}
                  series={[
                    { label: "VE", y: points.map((p) => p.lastCycle.veAtm), color: "#4FC3F7", showPoints: true },
                    ...(compare ? [
                      { label: "VE (cmp)", xs: comparePoints.map((p) => p.rpm), y: comparePoints.map((p) => p.lastCycle.veAtm), color: "#5A5F66", showPoints: false },
                    ] : []),
                  ]}
                  xLabel="rpm" yLabel="VE" height={340}
                />
              </ChartCard>
              <ChartCard>
                <LinePlot
                  title="EGT (K) vs RPM"
                  xs={points.map((p) => p.rpm)}
                  series={[
                    { label: "EGT", y: points.map((p) => p.lastCycle.egtMean), color: "#F48FB1", showPoints: true },
                    ...(compare ? [
                      { label: "EGT (cmp)", xs: comparePoints.map((p) => p.rpm), y: comparePoints.map((p) => p.lastCycle.egtMean), color: "#5A5F66", showPoints: false },
                    ] : []),
                  ]}
                  xLabel="rpm" yLabel="K" height={340}
                />
              </ChartCard>
              <ChartCard>
                <LinePlot
                  title="Indicated & Brake power (kW) vs RPM"
                  xs={points.map((p) => p.rpm)}
                  series={[
                    { label: "P_ind", y: points.map((p) => p.lastCycle.indicatedPowerKW), color: "#FFC627", showPoints: true },
                    { label: "P_brake", y: points.map((p) => p.lastCycle.brakePowerKW), color: "#A5D6A7", showPoints: true },
                    ...(compare ? [
                      { label: "P_ind (cmp)", xs: comparePoints.map((p) => p.rpm), y: comparePoints.map((p) => p.lastCycle.indicatedPowerKW), color: "#5A5F66", showPoints: false },
                    ] : []),
                    ...(dynoPowerSeries ? [
                      { label: "P dyno", xs: dynoPowerSeries.map((d) => d.rpm), y: dynoPowerSeries.map((d) => d.v), color: "#CE93D8", showPoints: true },
                    ] : []),
                  ]}
                  xLabel="rpm" yLabel="kW" height={340}
                />
              </ChartCard>
              <ChartCard>
                <LinePlot
                  title="Brake torque (Nm) vs RPM"
                  xs={points.map((p) => p.rpm)}
                  series={[
                    { label: "τ_brake", y: points.map((p) => p.lastCycle.brakeTorqueNm), color: "#FF8A65", showPoints: true },
                    ...(compare ? [
                      { label: "τ_brake (cmp)", xs: comparePoints.map((p) => p.rpm), y: comparePoints.map((p) => p.lastCycle.brakeTorqueNm), color: "#5A5F66", showPoints: false },
                    ] : []),
                    ...(dynoTorqueSeries ? [
                      { label: "τ dyno", xs: dynoTorqueSeries.map((d) => d.rpm), y: dynoTorqueSeries.map((d) => d.v), color: "#CE93D8", showPoints: true },
                    ] : []),
                  ]}
                  xLabel="rpm" yLabel="Nm" height={340}
                />
              </ChartCard>
              {hasKnock && (
                <ChartCard>
                  <LinePlot
                    title="Knock integral vs RPM"
                    xs={points.map((p) => p.rpm)}
                    series={[
                      { label: "KI", y: points.map((p) => p.lastCycle.knockIntegral ?? NaN), color: "#F48FB1", showPoints: true },
                      ...(compare ? [
                        { label: "KI (cmp)", xs: comparePoints.map((p) => p.rpm), y: comparePoints.map((p) => p.lastCycle.knockIntegral ?? NaN), color: "#5A5F66", showPoints: false },
                      ] : []),
                    ]}
                    xLabel="rpm" yLabel="KI" height={340}
                  />
                </ChartCard>
              )}
            </div>

            {/* Per-RPM table */}
            <section className="m-2 mt-3 rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
                <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">Per-RPM</div>
                <div className="text-[10px] text-[#5A5F66]">{points.length} rpm</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] text-left font-mono text-[11px]">
                  <thead className="bg-[#0B0B0D] text-[10px] uppercase tracking-wider text-[#5A5F66]">
                    <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-normal">
                      <th>RPM</th>
                      <th className="text-right">conv@</th>
                      <th className="text-right">cycles</th>
                      <th className="text-right">IMEP</th>
                      <th className="text-right">VE</th>
                      <th className="text-right">EGT</th>
                      <th className="text-right">P_ind</th>
                      <th className="text-right">τ_brake</th>
                      {hasKnock && <th className="text-right">KI</th>}
                      <th className="text-right">nonc.max</th>
                      <th className="text-right">wall t</th>
                      <th>captures</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => {
                      const open = expandedRpm === p.rpm;
                      // Critical: key MUST live on the Fragment so React
                      // can track row+expand-content identity across
                      // re-renders. Without it, expanded children
                      // (PvLoopView / PipeProfileView with their own
                      // useEffect data loads) remount on every parent
                      // re-render — which broke the charts.
                      return (
                        <Fragment key={p.rpm}>
                          <tr className={"border-t border-[#16171B] " + (open ? "bg-[#16171B]" : "text-[#9097A0] hover:bg-[#16171B]/50")}>
                            <td className="px-2 py-1 tabular-nums">{p.rpm.toFixed(0)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.convergedCycle < 0 ? "—" : p.convergedCycle}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.nCyclesRun}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.lastCycle.imepBar.toFixed(3)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{(p.lastCycle.veAtm * 100).toFixed(2)}%</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.lastCycle.egtMean.toFixed(0)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.lastCycle.indicatedPowerKW.toFixed(2)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.lastCycle.brakeTorqueNm.toFixed(2)}</td>
                            {hasKnock && (
                              <td className="px-2 py-1 text-right tabular-nums">
                                {p.lastCycle.knockIntegral != null ? p.lastCycle.knockIntegral.toFixed(3) : "—"}
                              </td>
                            )}
                            <td className="px-2 py-1 text-right tabular-nums">{p.nonconservationMax.toExponential(2)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{p.wallTimeS.toFixed(2)}s</td>
                            <td className="px-2 py-1 text-[10px] text-[#5A5F66]">
                              {p.captureDir ? "yes" : "—"}
                            </td>
                            <td className="px-2 py-1 text-right text-[10px] uppercase tracking-wider">
                              <button type="button"
                                className="px-1 text-[#FFC627] hover:underline"
                                onClick={() => setExpandedRpm(open ? null : p.rpm)}>
                                {open ? "Hide" : "Open"}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr className="border-t border-[#16171B] bg-[#0B0B0D]">
                              <td colSpan={hasKnock ? 13 : 12} className="p-3">
                                {p.captureDir && study.params.capturePvLoops && (
                                  <PvLoopView jobId={study.id} studyKind="sweep" rpmInt={Math.round(p.rpm)} />
                                )}
                                {p.captureDir && study.params.capturePipeProfiles && (
                                  <PipeProfileView jobId={study.id} studyKind="sweep" rpmInt={Math.round(p.rpm)} />
                                )}
                                {p.captureDir && study.params.captureWaves && (
                                  <div className="mt-2">
                                    <button
                                      type="button"
                                      className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] text-[#9097A0] hover:border-[#FFC627]"
                                      onClick={() => setWaveViewerRpm(Math.round(p.rpm))}
                                    >
                                      Open wave viewer ↗
                                    </button>
                                  </div>
                                )}
                                {!p.captureDir && (
                                  <div className="text-[11px] text-[#5A5F66]">
                                    No captures for this RPM. Re-run sweep with P-V / profile capture enabled to view this view.
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
      {study.params.captureWaves && waveViewerRpm != null && (
        <WaveViewerModal
          open
          bridge={bridge}
          jobId={study.id}
          studyKind="sweep"
          rpmInt={waveViewerRpm}
          sweepCapturedRpms={sweepCapturedRpms}
          onClose={() => setWaveViewerRpm(null)}
        />
      )}
    </div>
  );
}

function SummaryStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">{label}</span>
      <span className="font-mono tabular-nums text-[#D8DCE2]">{children}</span>
    </span>
  );
}

function ChartCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: SweepStudy["status"] }) {
  const styles: Record<SweepStudy["status"], string> = {
    idle:        "border-[#2A2C32] text-[#5A5F66]",
    running:     "border-[#FFC627]/40 text-[#FFC627]",
    cancelling:  "border-amber-500/40 text-amber-300",
    done:        "border-green-500/40 text-green-300",
    cancelled:   "border-[#2A2C32] text-[#5A5F66]",
    error:       "border-red-500/40 text-red-300",
  };
  return (
    <span className={"ml-1 rounded-sm border px-1.5 py-[1px] text-[9px] " + styles[status]}>
      {status}
    </span>
  );
}
