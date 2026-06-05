// Single source of truth for CycleStats metric metadata.
//
// Drives chart labels/units, CSV header + units rows, and objective labels.
// Each entry maps a CycleStats key to:
//   - csvName:  readable snake_case column name for CSV (no unit suffix)
//   - label:    short human label for chart legends / summaries
//   - unit:     physical unit string for the CSV units row ('' / '-' when none)
//   - decimals: default display precision
//   - wireName: the snake_case serde name the backend uses (CycleStats field).
//
// SERDE LANDMINE: serde renames split trailing capitalized acronyms, so the
// power fields are `indicated_power_k_w` / `brake_power_k_w` / `wheel_power_k_w`
// (NOT `..._kw`). These wire names are copied verbatim from the backend-matched
// METRICS list in components/optimization/ObjectiveBuilder.tsx — do not
// hand-roll camelCase→snake_case here.

import type {
  CycleStats,
  ObjectiveAggregator,
  ObjectiveSpec,
} from "../state/types";

export interface MetricMeta {
  key: keyof CycleStats & string;
  csvName: string;
  label: string;
  unit: string;
  decimals: number;
  wireName: string;
}

// Ordered so charts/CSVs read in a sensible engineering order: the headline
// performance metrics first, then conservation/diagnostic bookkeeping, then the
// horsepower mirrors of the kW power fields at the end.
export const CYCLE_METRICS: MetricMeta[] = [
  { key: "cycle", csvName: "cycle", label: "cycle", unit: "-", decimals: 0, wireName: "cycle" },
  { key: "imepBar", csvName: "imep", label: "IMEP", unit: "bar", decimals: 3, wireName: "imep_bar" },
  { key: "bmepBar", csvName: "bmep", label: "BMEP", unit: "bar", decimals: 3, wireName: "bmep_bar" },
  { key: "fmepBar", csvName: "fmep", label: "FMEP", unit: "bar", decimals: 3, wireName: "fmep_bar" },
  { key: "veAtm", csvName: "ve_atm", label: "VE_atm", unit: "-", decimals: 4, wireName: "ve_atm" },
  { key: "intakeMassPerCycleG", csvName: "intake_mass_per_cycle", label: "intake mass/cycle", unit: "g", decimals: 4, wireName: "intake_mass_per_cycle_g" },
  { key: "fResidual", csvName: "f_residual", label: "residual fraction", unit: "-", decimals: 4, wireName: "f_residual" },
  { key: "indicatedPowerKW", csvName: "indicated_power", label: "indicated power", unit: "kW", decimals: 2, wireName: "indicated_power_k_w" },
  { key: "brakePowerKW", csvName: "brake_power", label: "brake power", unit: "kW", decimals: 2, wireName: "brake_power_k_w" },
  { key: "wheelPowerKW", csvName: "wheel_power", label: "wheel power", unit: "kW", decimals: 2, wireName: "wheel_power_k_w" },
  { key: "indicatedTorqueNm", csvName: "indicated_torque", label: "indicated torque", unit: "Nm", decimals: 2, wireName: "indicated_torque_nm" },
  { key: "brakeTorqueNm", csvName: "brake_torque", label: "brake torque", unit: "Nm", decimals: 2, wireName: "brake_torque_nm" },
  { key: "wheelTorqueNm", csvName: "wheel_torque", label: "wheel torque", unit: "Nm", decimals: 2, wireName: "wheel_torque_nm" },
  { key: "egtMean", csvName: "egt_mean", label: "EGT mean", unit: "K", decimals: 1, wireName: "egt_mean" },
  { key: "knockIntegral", csvName: "knock_integral", label: "knock integral", unit: "-", decimals: 4, wireName: "knock_integral" },
  { key: "massTotal", csvName: "mass_total", label: "mass total", unit: "kg", decimals: 6, wireName: "mass_total" },
  { key: "massDrift", csvName: "mass_drift", label: "mass drift", unit: "kg", decimals: 6, wireName: "mass_drift" },
  { key: "massInRestrictor", csvName: "mass_in_restrictor", label: "mass in (restrictor)", unit: "kg", decimals: 6, wireName: "mass_in_restrictor" },
  { key: "massOutCollector", csvName: "mass_out_collector", label: "mass out (collector)", unit: "kg", decimals: 6, wireName: "mass_out_collector" },
  { key: "netPortFlow", csvName: "net_port_flow", label: "net port flow", unit: "kg", decimals: 6, wireName: "net_port_flow" },
  { key: "nonconservation", csvName: "nonconservation", label: "non-conservation", unit: "kg", decimals: 6, wireName: "nonconservation" },
  { key: "indicatedPowerHp", csvName: "indicated_power_hp", label: "indicated power", unit: "hp", decimals: 2, wireName: "indicated_power_hp" },
  { key: "brakePowerHp", csvName: "brake_power_hp", label: "brake power", unit: "hp", decimals: 2, wireName: "brake_power_hp" },
  { key: "wheelPowerHp", csvName: "wheel_power_hp", label: "wheel power", unit: "hp", decimals: 2, wireName: "wheel_power_hp" },
];

// Lookup tables built once; both wire names and CycleStats keys are unique.
const BY_WIRE = new Map<string, MetricMeta>(CYCLE_METRICS.map((m) => [m.wireName, m]));
const BY_KEY = new Map<string, MetricMeta>(CYCLE_METRICS.map((m) => [m.key, m]));

/** Find metadata by the backend snake_case serde name (e.g. "brake_power_k_w"). */
export function metricByWire(wire: string): MetricMeta | undefined {
  return BY_WIRE.get(wire);
}

/** Find metadata by the CycleStats camelCase key (e.g. "brakePowerKW"). */
export function metricByKey(key: string): MetricMeta | undefined {
  return BY_KEY.get(key);
}

// Aggregator → readable phrase. The objective metric is looked up by its wire
// name; "at-rpm" carries a concrete rpm, the rest fold over the rpm list.
function aggregatorPhrase(agg: ObjectiveAggregator, nRpm: number): string {
  switch (agg.kind) {
    case "max":
      return `max over ${nRpm} rpm`;
    case "min":
      return `min over ${nRpm} rpm`;
    case "mean":
      return `mean over ${nRpm} rpm`;
    case "auc":
      return `area-under-curve over ${nRpm} rpm`;
    case "sum":
      return `sum over ${nRpm} rpm`;
    case "at-rpm":
      return `at ${agg.rpmInt} rpm`;
  }
}

/** Human label for an objective, e.g. "max over 7 rpm of brake power — maximize". */
export function objectiveLabel(spec: ObjectiveSpec): string {
  const meta = metricByWire(spec.metric);
  const metricLabel = meta ? meta.label : spec.metric;
  const phrase = aggregatorPhrase(spec.aggregator, spec.rpmList.length);
  return `${phrase} of ${metricLabel} — ${spec.direction}`;
}

/** Unit of the objective's underlying metric ('' when the metric is unknown). */
export function objectiveUnit(spec: ObjectiveSpec): string {
  const meta = metricByWire(spec.metric);
  return meta ? meta.unit : "";
}
