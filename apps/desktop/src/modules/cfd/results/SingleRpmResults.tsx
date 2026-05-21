import { useMemo } from "react";

import { CycleChart } from "../components/charts/CycleChart";
import { useCfd } from "../state/CfdContext";
import { basename } from "../lib/cfdPath";
import type { SingleRpmStudy } from "../state/types";

interface Props {
  study: SingleRpmStudy;
}

export function SingleRpmResults({ study }: Props) {
  const { cancelStudy } = useCfd();
  const last = study.cycles[study.cycles.length - 1];
  const elapsed = useMemo(() => {
    const end = study.finishedAt ?? Date.now();
    return ((end - study.startedAt) / 1000).toFixed(1);
  }, [study.finishedAt, study.startedAt]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-helios-line bg-helios-base px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-helios-text">
              Single-RPM run · {study.params.rpm.toFixed(0)} rpm · {study.params.junctionKind}
            </h1>
            <p className="text-xs text-helios-dim" title={study.configPath}>
              {basename(study.configPath)} · {study.cycles.length} / {study.params.nCyclesMax} cycles
              · {elapsed}s
              · <StatusText status={study.status} />
              {study.summary && study.summary.convergedCycle >= 0 && (
                <> · converged at cycle {study.summary.convergedCycle}</>
              )}
            </p>
            {study.error && (
              <p className="mt-1 text-xs text-red-300" role="alert">
                {study.errorReason ? `${study.errorReason}: ` : ""}{study.error}
              </p>
            )}
          </div>
          {study.status === "running" && (
            <button
              type="button"
              className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/20"
              onClick={() => cancelStudy(study.id)}
            >
              Cancel
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4">
        {study.cycles.length === 0 ? (
          <div className="rounded border border-helios-line bg-helios-panel p-8 text-center text-sm text-helios-dim">
            {study.status === "running" ? "Waiting for the first cycle…" : "No cycles to display."}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <ChartCard>
                <CycleChart
                  title="IMEP / BMEP / FMEP (bar)"
                  cycles={study.cycles}
                  series={[
                    { label: "IMEP", field: "imepBar", color: "#4FC3F7" },
                    { label: "BMEP", field: "bmepBar", color: "#A5D6A7" },
                    { label: "FMEP", field: "fmepBar", color: "#FFB300" },
                  ]}
                  yLabel="bar"
                />
              </ChartCard>
              <ChartCard>
                <CycleChart
                  title="VE (%) and Indicated power (kW)"
                  cycles={study.cycles}
                  series={[
                    { label: "VE", field: "veAtm", color: "#CE93D8" },
                    { label: "P_ind (kW)", field: "indicatedPowerKW", color: "#FF8A65", axis: "y2" },
                  ]}
                  yLabel="VE"
                  y2Label="kW"
                />
              </ChartCard>
              <ChartCard>
                <CycleChart
                  title="EGT mean (K)"
                  cycles={study.cycles}
                  series={[{ label: "EGT", field: "egtMean", color: "#F48FB1" }]}
                  yLabel="K"
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
                />
              </ChartCard>
            </div>

            <section className="mt-4 overflow-x-auto rounded border border-helios-line bg-helios-panel">
              <table className="w-full min-w-[1000px] text-left text-xs">
                <thead className="text-helios-dim">
                  <tr className="[&>th]:px-2 [&>th]:py-1.5">
                    <th className="text-right">#</th>
                    <th className="text-right">IMEP</th>
                    <th className="text-right">BMEP</th>
                    <th className="text-right">FMEP</th>
                    <th className="text-right">VE</th>
                    <th className="text-right">EGT (K)</th>
                    <th className="text-right">P_ind (kW)</th>
                    <th className="text-right">P_brake (kW)</th>
                    <th className="text-right">P_wheel (kW)</th>
                    <th className="text-right">τ_ind (Nm)</th>
                    <th className="text-right">τ_brake (Nm)</th>
                    <th className="text-right">τ_wheel (Nm)</th>
                    <th className="text-right">m drift</th>
                    <th className="text-right">nonconserv</th>
                  </tr>
                </thead>
                <tbody>
                  {study.cycles.map((c, i) => {
                    const isLast = i === study.cycles.length - 1;
                    return (
                      <tr key={i} className={"border-t border-helios-line " + (isLast ? "font-semibold text-helios-text" : "")}>
                        <td className="px-2 py-1 text-right text-helios-dim">{c.cycle}</td>
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
            </section>
            {last && (
              <div className="mt-2 text-xs text-helios-dim">
                Last cycle: IMEP={last.imepBar.toFixed(3)} bar · VE={(last.veAtm * 100).toFixed(2)}% · EGT={last.egtMean.toFixed(0)} K · P_ind={last.indicatedPowerKW.toFixed(2)} kW
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ChartCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-helios-line bg-helios-panel p-3">{children}</div>;
}

function StatusText({ status }: { status: SingleRpmStudy["status"] }) {
  const labels: Record<SingleRpmStudy["status"], string> = {
    idle: "idle",
    running: "running",
    cancelling: "cancelling…",
    done: "done",
    cancelled: "cancelled",
    error: "error",
  };
  return <span className="text-helios-text">{labels[status]}</span>;
}
