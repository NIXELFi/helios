// Per-trial detail pane shown to the right of the parallel-coords plot.
// Displays parameter values + the per-RPM brake torque / power / IMEP
// curves from this trial's stored sweep points. We reuse the shared
// LinePlot uPlot wrapper, matching the SweepResults call shape.

import { LinePlot } from "../components/charts/LinePlot";
import type { OptimizationTrial } from "../state/types";

interface Props {
  trial: OptimizationTrial;
  parameterPaths: string[];
}

export function TrialInspector({ trial, parameterPaths }: Props) {
  const points = trial.sweepPoints ?? [];
  const rpms = points.map((p) => p.rpm);
  const torque = points.map((p) => p.lastCycle.brakeTorqueNm);
  const power = points.map((p) => p.lastCycle.brakePowerKW);
  const imep = points.map((p) => p.lastCycle.imepBar);

  return (
    <div className="space-y-3">
      <header className="text-[11px]">
        <div className="text-[10px] uppercase tracking-wider text-[#FFC627]">
          Trial #{trial.trialIdx}
        </div>
        <div className="mt-1 font-mono text-[#9097A0]">
          obj = {trial.objectiveValue !== null ? trial.objectiveValue.toPrecision(5) : "—"}
          {trial.wallTimeS !== null && (
            <span className="ml-2 text-[#5A5F66]">{trial.wallTimeS.toFixed(2)} s</span>
          )}
        </div>
      </header>

      <div>
        <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#5A5F66]">
          Parameter values
        </h4>
        <table className="w-full text-[11px]">
          <tbody className="font-mono">
            {parameterPaths.map((p) => (
              <tr key={p} className="border-t border-[#16171B]">
                <td className="px-2 py-0.5 text-[#9097A0]">{p}</td>
                <td className="px-2 py-0.5 text-right text-[#D8DCE2]">
                  {trial.parameterValues[p] !== undefined
                    ? trial.parameterValues[p]!.toPrecision(5)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {points.length > 0 && (
        <div className="space-y-2">
          <div className="h-[160px]">
            <LinePlot
              title="brake torque vs RPM"
              xs={rpms}
              series={[{ label: "Nm", y: torque, color: "#FFC627", showPoints: true }]}
              xLabel="rpm"
              yLabel="Nm"
              height={160}
            />
          </div>
          <div className="h-[160px]">
            <LinePlot
              title="brake power vs RPM"
              xs={rpms}
              series={[{ label: "kW", y: power, color: "#A5D6A7", showPoints: true }]}
              xLabel="rpm"
              yLabel="kW"
              height={160}
            />
          </div>
          <div className="h-[160px]">
            <LinePlot
              title="IMEP vs RPM"
              xs={rpms}
              series={[{ label: "bar", y: imep, color: "#4FC3F7", showPoints: true }]}
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
