import { useMemo, useState } from "react";

import { CycleChart } from "../components/charts/CycleChart";
import { PvLoopView } from "./PvLoopView";
import { PipeProfileView } from "./PipeProfileView";
import { WaveViewerModal } from "./wave-viewer";
import { useCfd } from "../state/CfdContext";
import { basename } from "../lib/cfdPath";
import type { SingleRpmStudy } from "../state/types";

interface Props {
  study: SingleRpmStudy;
}

export function SingleRpmResults({ study }: Props) {
  const { cancelStudy, bridge } = useCfd();
  const [showPv, setShowPv] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [showWaveViewer, setShowWaveViewer] = useState(false);
  const last = study.cycles[study.cycles.length - 1];
  const elapsed = useMemo(() => {
    const end = study.finishedAt ?? Date.now();
    return ((end - study.startedAt) / 1000).toFixed(1);
  }, [study.finishedAt, study.startedAt]);
  const hasCaptures = !!study.summary?.captureDir;
  const rpmInt = Math.round(study.params.rpm);

  return (
    <div className="flex h-full flex-col bg-[#0B0B0D] text-[#D8DCE2]">
      {/* Header strip — matches Logs WorkspaceTabBar density */}
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[11px] uppercase tracking-wider text-[#9097A0]">
            <span className="text-[#FFC627]">Single-RPM</span>
            <span>·</span>
            <span>{study.params.rpm.toFixed(0)} rpm</span>
            <span>·</span>
            <span>{study.params.junctionKind}</span>
            <StatusBadge status={study.status} />
          </div>
          <div className="mt-0.5 truncate text-[10px] text-[#5A5F66]" title={study.configPath}>
            {basename(study.configPath)} · {study.cycles.length}/{study.params.nCyclesMax} cycles · {elapsed}s
            {study.summary && study.summary.convergedCycle >= 0 && (
              <> · converged @ cycle {study.summary.convergedCycle}</>
            )}
          </div>
          {study.error && (
            <div className="mt-0.5 text-[10px] text-red-300" role="alert">
              {study.errorReason ? `${study.errorReason}: ` : ""}{study.error}
            </div>
          )}
        </div>
        {study.status === "running" && (
          <button
            type="button"
            className="rounded-sm border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] uppercase tracking-wider text-red-200 hover:bg-red-500/20"
            onClick={() => cancelStudy(study.id)}
          >
            Cancel
          </button>
        )}
      </header>

      {/* Scrollable body so charts + table never push each other off-screen */}
      <div className="flex-1 min-h-0 overflow-auto">
        {study.cycles.length === 0 ? (
          <div className="m-6 rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-8 text-center text-[11px] text-[#5A5F66]">
            {study.status === "running" ? "Waiting for the first cycle…" : "No cycles to display."}
          </div>
        ) : (
          <>
            {/* Charts grid — each card constrains its own height so charts
                cannot push the table or each other. Min row height is
                large enough that uPlot axis labels never clip into the
                title strip or out of the plot. */}
            <div className="grid grid-cols-1 gap-2 p-2 xl:grid-cols-2">
              <ChartCard>
                <CycleChart
                  title="IMEP / BMEP / FMEP (bar)"
                  cycles={study.cycles}
                  series={[
                    { label: "IMEP", field: "imepBar", color: "#FFC627" },
                    { label: "BMEP", field: "bmepBar", color: "#A5D6A7" },
                    { label: "FMEP", field: "fmepBar", color: "#FF8A65" },
                  ]}
                  yLabel="bar"
                  height={260}
                />
              </ChartCard>
              <ChartCard>
                <CycleChart
                  title="VE & Indicated power"
                  cycles={study.cycles}
                  series={[
                    { label: "VE", field: "veAtm", color: "#4FC3F7" },
                    { label: "P_ind (kW)", field: "indicatedPowerKW", color: "#CE93D8", axis: "y2" },
                  ]}
                  yLabel="VE"
                  y2Label="kW"
                  height={260}
                />
              </ChartCard>
              <ChartCard>
                <CycleChart
                  title="EGT (K)"
                  cycles={study.cycles}
                  series={[{ label: "EGT", field: "egtMean", color: "#F48FB1" }]}
                  yLabel="K"
                  height={260}
                />
              </ChartCard>
              <ChartCard>
                <CycleChart
                  title="Mass drift / nonconservation (kg)"
                  cycles={study.cycles}
                  series={[
                    { label: "drift", field: "massDrift", color: "#4FC3F7" },
                    { label: "nonconserv", field: "nonconservation", color: "#FFB300" },
                  ]}
                  yLabel="kg"
                  height={260}
                />
              </ChartCard>
            </div>

            {/* Cycle table — sits below the charts, never overlaps them */}
            <section className="m-2 mt-3 rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
                <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">
                  Cycle stats
                </div>
                <div className="text-[10px] text-[#5A5F66]">
                  {study.cycles.length} cycle{study.cycles.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] text-left font-mono text-[11px]">
                  <thead className="bg-[#0B0B0D] text-[10px] uppercase tracking-wider text-[#5A5F66]">
                    <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-normal">
                      <th className="text-right">#</th>
                      <th className="text-right">IMEP</th>
                      <th className="text-right">BMEP</th>
                      <th className="text-right">FMEP</th>
                      <th className="text-right">VE</th>
                      <th className="text-right">EGT</th>
                      <th className="text-right">P_ind</th>
                      <th className="text-right">P_brake</th>
                      <th className="text-right">P_wheel</th>
                      <th className="text-right">τ_ind</th>
                      <th className="text-right">τ_brake</th>
                      <th className="text-right">τ_wheel</th>
                      <th className="text-right">m drift</th>
                      <th className="text-right">nonc.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {study.cycles.map((c, i) => {
                      const isLast = i === study.cycles.length - 1;
                      return (
                        <tr
                          key={i}
                          className={
                            "border-t border-[#16171B] " +
                            (isLast ? "bg-[#16171B] text-[#D8DCE2]" : "text-[#9097A0] hover:bg-[#16171B]/50")
                          }
                        >
                          <td className="px-2 py-1 text-right text-[#5A5F66]">{c.cycle}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.imepBar.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.bmepBar.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.fmepBar.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{(c.veAtm * 100).toFixed(2)}%</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.egtMean.toFixed(1)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.indicatedPowerKW.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.brakePowerKW.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.wheelPowerKW.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.indicatedTorqueNm.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.brakeTorqueNm.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.wheelTorqueNm.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.massDrift.toExponential(2)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{c.nonconservation.toExponential(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {last && (
              <div className="px-3 pb-3 text-[10px] text-[#5A5F66]">
                Last cycle: IMEP <span className="text-[#D8DCE2]">{last.imepBar.toFixed(3)}</span> bar · VE <span className="text-[#D8DCE2]">{(last.veAtm * 100).toFixed(2)}%</span> · EGT <span className="text-[#D8DCE2]">{last.egtMean.toFixed(0)}</span> K · P_ind <span className="text-[#D8DCE2]">{last.indicatedPowerKW.toFixed(2)}</span> kW
              </div>
            )}

            {hasCaptures && (
              <section className="m-2 mt-3 rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <div className="flex items-center gap-2 border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider">
                  <span className="text-[#9097A0]">Captures</span>
                  {study.params.capturePvLoops && (
                    <button type="button"
                      className={
                        "rounded-sm border px-2 py-0.5 " +
                        (showPv ? "border-[#FFC627] bg-[#FFC627]/10 text-[#FFC627]" : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]")
                      }
                      onClick={() => setShowPv((v) => !v)}>
                      {showPv ? "Hide P-V" : "Show P-V"}
                    </button>
                  )}
                  {study.params.capturePipeProfiles && (
                    <button type="button"
                      className={
                        "rounded-sm border px-2 py-0.5 " +
                        (showProfiles ? "border-[#FFC627] bg-[#FFC627]/10 text-[#FFC627]" : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]")
                      }
                      onClick={() => setShowProfiles((v) => !v)}>
                      {showProfiles ? "Hide profiles" : "Show profiles"}
                    </button>
                  )}
                  {study.params.captureWaves && (
                    <button
                      type="button"
                      className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] text-[#9097A0] hover:border-[#FFC627]"
                      onClick={() => setShowWaveViewer(true)}
                    >
                      Open wave viewer ↗
                    </button>
                  )}
                </div>
                {showPv && (
                  <div className="p-2">
                    <PvLoopView jobId={study.id} studyKind="single-rpm" rpmInt={rpmInt} />
                  </div>
                )}
                {showProfiles && (
                  <div className="p-2">
                    <PipeProfileView jobId={study.id} studyKind="single-rpm" rpmInt={rpmInt} />
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {study.params.captureWaves && (
        <WaveViewerModal
          open={showWaveViewer}
          bridge={bridge}
          jobId={study.id}
          studyKind="single-rpm"
          rpmInt={rpmInt}
          onClose={() => setShowWaveViewer(false)}
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

function StatusBadge({ status }: { status: SingleRpmStudy["status"] }) {
  const styles: Record<SingleRpmStudy["status"], string> = {
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
