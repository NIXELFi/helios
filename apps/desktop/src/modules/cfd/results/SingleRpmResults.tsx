import { useMemo, useState } from "react";

import { CycleChart } from "../components/charts/CycleChart";
import { LinePlot } from "../components/charts/LinePlot";
import { ExportMenu } from "../components/ExportMenu";
import type { ExportMenuItem } from "../components/ExportMenu";
import { PvLoopView } from "./PvLoopView";
import { PipeProfileView } from "./PipeProfileView";
import { WaveViewerModal } from "./wave-viewer";
import { useCfd } from "../state/CfdContext";
import { basename } from "../lib/cfdPath";
import { imepDeltaSeries, covLastN, maxKnockIntegral } from "../lib/analytics/cycleStats";
import type { ExportAction } from "../lib/export/exportStudy";
import { exportActionsFor } from "../lib/export/exportStudy";
import { copyText } from "../lib/export/io";
import type { SingleRpmStudy } from "../state/types";

interface Props {
  study: SingleRpmStudy;
}

/** Adapt an ExportAction (resolves to a written path / null on cancel) into the
 *  ExportMenuItem shape the generic menu wants ({ok, message}). A written path
 *  becomes a success toast; a cancelled save dialog (null) shows "Cancelled"
 *  (the menu surfaces a toast for any non-empty message); a throw is an error
 *  toast. */
function actionToMenuItem(action: ExportAction): ExportMenuItem {
  return {
    id: action.id,
    label: action.label,
    run: async () => {
      try {
        const path = await action.run();
        if (path == null) return { ok: true, message: "Cancelled" };
        return { ok: true, message: `Exported → ${basename(path)}` };
      } catch (err) {
        return { ok: false, message: String(err) };
      }
    },
  };
}

export function SingleRpmResults({ study }: Props) {
  const { cancelStudy, bridge } = useCfd();
  const [showPv, setShowPv] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [showWaveViewer, setShowWaveViewer] = useState(false);
  const [showConvergence, setShowConvergence] = useState(false);
  const last = study.cycles[study.cycles.length - 1];
  const elapsed = useMemo(() => {
    const end = study.finishedAt ?? Date.now();
    return ((end - study.startedAt) / 1000).toFixed(1);
  }, [study.finishedAt, study.startedAt]);
  const hasCaptures = !!study.summary?.captureDir;
  const rpmInt = Math.round(study.params.rpm);

  // Summary analytics — all DISPLAY-ONLY. The convergence verdict is the
  // backend's summary.convergedCycle (never re-derived); the IMEP-delta series
  // and CoV are visualization aids only.
  const kiMax = useMemo(() => maxKnockIntegral(study.cycles), [study.cycles]);
  const covImep = useMemo(() => covLastN(study.cycles, "imepBar", 5), [study.cycles]);
  const deltas = useMemo(() => imepDeltaSeries(study.cycles), [study.cycles]);
  const convergedCycle =
    study.summary && study.summary.convergedCycle >= 0 ? study.summary.convergedCycle : null;
  const tolPct = study.params.convergenceTolImep * 100;

  // One-line summary text for the Copy button + Copy-summary export item.
  const summaryLine = useMemo(() => {
    if (!last) return "";
    const parts = [
      `IMEP ${last.imepBar.toFixed(3)} bar`,
      `VE ${(last.veAtm * 100).toFixed(2)}%`,
      `P_brake ${last.brakePowerKW.toFixed(2)} kW`,
      `τ_brake ${last.brakeTorqueNm.toFixed(2)} Nm`,
      `EGT ${last.egtMean.toFixed(0)} K`,
    ];
    if (kiMax != null) parts.push(`KI max ${kiMax.toFixed(3)}`);
    if (convergedCycle != null) parts.push(`conv @ ${convergedCycle}`);
    if (covImep != null) parts.push(`CoV(IMEP, last 5) ${(covImep * 100).toFixed(2)}%`);
    return parts.join(" · ");
  }, [last, kiMax, convergedCycle, covImep]);

  // Export menu items: per-kind ExportActions + a Copy-summary clipboard item.
  const exportItems = useMemo<ExportMenuItem[]>(() => {
    const items = exportActionsFor(study).map(actionToMenuItem);
    if (summaryLine) {
      items.push({
        id: "single-copy-summary",
        label: "Copy summary",
        run: async () => {
          await copyText(summaryLine);
          return { ok: true, message: "Copied!" };
        },
      });
    }
    return items;
  }, [study, summaryLine]);

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
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
        <ExportMenu items={exportItems} />
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

      {/* Summary card — final-cycle headline metrics + convergence / variation
          chips. Sits directly under the header so the key numbers are always
          visible without scrolling past the charts. */}
      {last && (
        <section aria-label="Run summary" className="flex-shrink-0 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#9097A0]">
            <SummaryStat label="IMEP" value={last.imepBar.toFixed(3)} unit="bar" />
            <SummaryStat label="VE" value={(last.veAtm * 100).toFixed(2)} unit="%" />
            <SummaryStat label="P_brake" value={last.brakePowerKW.toFixed(2)} unit="kW" />
            <SummaryStat label="τ_brake" value={last.brakeTorqueNm.toFixed(2)} unit="Nm" />
            <SummaryStat label="EGT" value={last.egtMean.toFixed(0)} unit="K" />
            {kiMax != null && (
              <span className="rounded-sm border border-[#FFC627]/40 px-1.5 py-[1px] text-[10px] text-[#FFC627]" title="Livengood-Wu knock integral (max over cycles)">
                KI max {kiMax.toFixed(3)}
              </span>
            )}
            {convergedCycle != null && (
              <span className="rounded-sm border border-green-500/40 px-1.5 py-[1px] text-[10px] text-green-300" title="Backend convergence verdict">
                conv @ {convergedCycle}
              </span>
            )}
            {covImep != null && (
              <SummaryStat label="CoV(IMEP, last 5)" value={(covImep * 100).toFixed(2)} unit="%" />
            )}
            <button
              type="button"
              className="ml-auto rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
              onClick={() => void copyText(summaryLine)}
              title="Copy the summary line to the clipboard"
            >
              Copy line
            </button>
          </div>
        </section>
      )}

      {/* Captures bar — sits below the header so the wave-viewer / P-V /
          profiles buttons are always reachable without scrolling past the
          charts + cycle table. */}
      {hasCaptures && (
        <section className="flex-shrink-0 border-b border-[#2A2C32] bg-[#0E0E10]">
          <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider">
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
        </section>
      )}

      {/* Scrollable body so charts + table never push each other off-screen */}
      <div className="flex-1 min-h-0 overflow-auto">
        {study.cycles.length === 0 ? (
          <div className="m-6 rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-8 text-center text-[11px] text-[#5A5F66]">
            {study.status === "running" ? "Waiting for the first cycle…" : "No cycles to display."}
          </div>
        ) : (
          <>
            {/* Convergence panel — collapsible. Plots the per-cycle relative
                IMEP change (display-only) against the configured tolerance so
                the user can eyeball how the run settled. The authoritative
                convergence verdict is the backend's convergedCycle. */}
            <section className="m-2 rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#9097A0]">
                  Convergence
                  {convergedCycle != null && (
                    <span className="text-[#5A5F66] normal-case tracking-normal">
                      backend converged @ cycle {convergedCycle}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={
                    "rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-wider " +
                    (showConvergence
                      ? "border-[#FFC627] bg-[#FFC627]/10 text-[#FFC627]"
                      : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]")
                  }
                  onClick={() => setShowConvergence((v) => !v)}
                >
                  {showConvergence ? "Hide convergence" : "Show convergence"}
                </button>
              </div>
              {showConvergence && (
                <div className="p-2">
                  {deltas.length === 0 ? (
                    <div className="px-2 py-6 text-center text-[11px] text-[#5A5F66]">
                      Need at least two cycles to chart convergence.
                    </div>
                  ) : (
                    <LinePlot
                      title={
                        "IMEP Δ% vs cycle" +
                        (convergedCycle != null ? ` (backend converged @ ${convergedCycle})` : "")
                      }
                      xs={deltas.map((d) => d.cycle)}
                      series={[
                        {
                          label: "|ΔIMEP|%",
                          y: deltas.map((d) => d.deltaPct * 100),
                          color: "#FFC627",
                          showPoints: true,
                        },
                        {
                          label: "tol",
                          y: deltas.map(() => tolPct),
                          color: "#5A5F66",
                          showPoints: false,
                        },
                      ]}
                      xLabel="cycle"
                      yLabel="%"
                      height={300}
                    />
                  )}
                </div>
              )}
            </section>

            {/* Charts — stacked full-width so each is large and the whole page
                scrolls. Each card sets its own height so axis labels never clip
                into the title strip or out of the plot. */}
            <div className="grid grid-cols-1 gap-2 p-2">
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
                  height={340}
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
                  height={340}
                />
              </ChartCard>
              <ChartCard>
                <CycleChart
                  title="EGT (K)"
                  cycles={study.cycles}
                  series={[{ label: "EGT", field: "egtMean", color: "#F48FB1" }]}
                  yLabel="K"
                  height={340}
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
                  height={340}
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

            {/* P-V and profile panels render here when toggled from the
                top Captures bar. */}
            {hasCaptures && (showPv || showProfiles) && (
              <section className="m-2 mt-3 rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
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

function SummaryStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      <span className="font-mono tabular-nums text-[#D8DCE2]">{value}</span>
      <span className="text-[10px] text-[#5A5F66]">{unit}</span>
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
