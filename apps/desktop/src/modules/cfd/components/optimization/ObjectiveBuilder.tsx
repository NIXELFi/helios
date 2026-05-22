// Builds an ObjectiveSpec: metric × aggregator × RPM list × direction.
// The RPM list text is owned by the parent so it can re-parse + validate
// in one place. Metric list is the snake_case names the backend
// recognizes (matched against CycleStats fields server-side).

import type {
  ObjectiveAggregator,
  ObjectiveSpec,
} from "../../state/types";
import { parseRpmList } from "../../lib/rpmList";

const METRICS: { value: string; label: string }[] = [
  { value: "imep_bar", label: "IMEP (bar)" },
  { value: "bmep_bar", label: "BMEP (bar)" },
  { value: "fmep_bar", label: "FMEP (bar)" },
  { value: "ve_atm", label: "VE_atm (-)" },
  { value: "indicated_power_k_w", label: "Indicated power (kW)" },
  { value: "brake_power_k_w", label: "Brake power (kW)" },
  { value: "wheel_power_k_w", label: "Wheel power (kW)" },
  { value: "indicated_torque_nm", label: "Indicated torque (Nm)" },
  { value: "brake_torque_nm", label: "Brake torque (Nm)" },
  { value: "wheel_torque_nm", label: "Wheel torque (Nm)" },
  { value: "egt_mean", label: "EGT mean (K)" },
  { value: "intake_mass_per_cycle_g", label: "Intake mass/cycle (g)" },
  { value: "f_residual", label: "Residual fraction (-)" },
  { value: "nonconservation", label: "Non-conservation (kg)" },
];

interface Props {
  value: ObjectiveSpec;
  rpmListText: string;
  onRpmListTextChange: (t: string) => void;
  onChange: (next: ObjectiveSpec) => void;
}

const INPUT_CLS =
  "block rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none";

export function ObjectiveBuilder({
  value,
  rpmListText,
  onRpmListTextChange,
  onChange,
}: Props) {
  const setAggregator = (kind: ObjectiveAggregator["kind"]) => {
    let next: ObjectiveAggregator;
    if (kind === "at-rpm") {
      const seed = value.rpmList[0] ?? 6000;
      next = { kind: "at-rpm", rpmInt: Math.round(seed) };
    } else {
      next = { kind } as ObjectiveAggregator;
    }
    onChange({ ...value, aggregator: next });
  };

  const rpmParse = parseRpmList(rpmListText);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">Metric</span>
        <select
          value={value.metric}
          onChange={(e) => onChange({ ...value, metric: e.target.value })}
          className={INPUT_CLS + " mt-1 w-full"}
        >
          {METRICS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">Aggregator</span>
        <select
          value={value.aggregator.kind}
          onChange={(e) =>
            setAggregator(e.target.value as ObjectiveAggregator["kind"])
          }
          className={INPUT_CLS + " mt-1 w-full"}
        >
          <option value="max">Max across RPM list</option>
          <option value="min">Min across RPM list</option>
          <option value="mean">Mean across RPM list</option>
          <option value="auc">Area under curve (trapezoidal)</option>
          <option value="sum">Sum across RPM list</option>
          <option value="at-rpm">At specific RPM</option>
        </select>
      </label>

      {value.aggregator.kind === "at-rpm" && (
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">RPM</span>
          <input
            type="number"
            value={value.aggregator.rpmInt}
            onChange={(e) =>
              onChange({
                ...value,
                aggregator: { kind: "at-rpm", rpmInt: Number(e.target.value) },
              })
            }
            className={INPUT_CLS + " mt-1 w-32"}
          />
        </label>
      )}

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">
          RPM list (e.g. 4000, 6000:12000:1000)
        </span>
        <input
          type="text"
          value={rpmListText}
          onChange={(e) => onRpmListTextChange(e.target.value)}
          className={INPUT_CLS + " mt-1 w-full"}
        />
        {!rpmParse.ok ? (
          <p className="mt-1 text-[10px] text-red-300" role="alert">{rpmParse.error}</p>
        ) : (
          <p className="mt-1 text-[10px] text-[#5A5F66]">
            {rpmParse.rpms.length} rpm: {rpmParse.rpms.slice(0, 6).join(", ")}
            {rpmParse.rpms.length > 6 ? "…" : ""}
          </p>
        )}
      </label>

      <fieldset className="flex gap-3">
        <legend className="text-[10px] uppercase tracking-wider text-[#5A5F66]">Direction</legend>
        <label className="flex items-center gap-1 text-[11px] text-[#D8DCE2]">
          <input
            type="radio"
            checked={value.direction === "maximize"}
            onChange={() => onChange({ ...value, direction: "maximize" })}
          />
          maximize
        </label>
        <label className="flex items-center gap-1 text-[11px] text-[#D8DCE2]">
          <input
            type="radio"
            checked={value.direction === "minimize"}
            onChange={() => onChange({ ...value, direction: "minimize" })}
          />
          minimize
        </label>
      </fieldset>
    </div>
  );
}
