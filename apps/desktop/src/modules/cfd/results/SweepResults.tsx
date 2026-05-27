import { Fragment, useMemo, useState } from "react";

import { LinePlot } from "../components/charts/LinePlot";
import { PvLoopView } from "./PvLoopView";
import { PipeProfileView } from "./PipeProfileView";
import { WaveViewerModal } from "./wave-viewer";
import { useCfd } from "../state/CfdContext";
import { basename } from "../lib/cfdPath";
import type { SweepStudy } from "../state/types";

interface Props {
  study: SweepStudy;
}

export function SweepResults({ study }: Props) {
  const { state, cancelStudy, setSweepCompare, bridge } = useCfd();
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
          <div className="mt-0.5 truncate text-[10px] text-[#5A5F66]" title={study.configPath}>
            {basename(study.configPath)} · {points.length}/{study.params.rpmList.length} rpm · {elapsed}s
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
              {basename(s.configPath)} · {s.params.rpmList.length} rpm · {s.params.junctionKind} · {new Date(s.startedAt).toLocaleTimeString()}
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
            {/* Curves grid */}
            <div className="grid grid-cols-1 gap-2 p-2 xl:grid-cols-2">
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
                  xLabel="rpm" yLabel="bar" height={260}
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
                  xLabel="rpm" yLabel="VE" height={260}
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
                  xLabel="rpm" yLabel="K" height={260}
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
                  ]}
                  xLabel="rpm" yLabel="kW" height={260}
                />
              </ChartCard>
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
                              <td colSpan={11} className="p-3">
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
