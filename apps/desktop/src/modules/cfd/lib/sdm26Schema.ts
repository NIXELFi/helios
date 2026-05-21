// Field metadata for rendering an SDM26 config's read-only summary
// (Phase 1) and editable form (Phase 2). Keys reference paths into
// the raw V1 JSON; format() converts the SI value to a display string.

export interface FieldMeta {
  key: string;            // dot-path into LoadedConfig.raw
  label: string;
  unit?: string;
  group: string;
  format?: (v: unknown) => string;
}

const f3 = (v: unknown) => (typeof v === "number" ? v.toFixed(3) : String(v));
const f2 = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : String(v));
const f1 = (v: unknown) => (typeof v === "number" ? v.toFixed(1) : String(v));
const f0 = (v: unknown) => (typeof v === "number" ? v.toFixed(0) : String(v));
const mm = (v: unknown) => (typeof v === "number" ? (v * 1000).toFixed(1) : String(v));
const mL = (v: unknown) => (typeof v === "number" ? (v * 1e6).toFixed(1) : String(v));
const L = (v: unknown) => (typeof v === "number" ? (v * 1000).toFixed(3) : String(v));

export const SDM26_SCHEMA: FieldMeta[] = [
  // Engine
  { key: "name", label: "Name", group: "Engine" },
  { key: "n_cylinders", label: "Cylinders", group: "Engine", format: f0 },
  { key: "firing_order", label: "Firing order", group: "Engine", format: (v) => Array.isArray(v) ? v.join("-") : String(v) },
  { key: "firing_interval", label: "Firing interval", unit: "°CA", group: "Engine", format: f1 },
  { key: "cylinder.bore", label: "Bore", unit: "mm", group: "Engine", format: mm },
  { key: "cylinder.stroke", label: "Stroke", unit: "mm", group: "Engine", format: mm },
  { key: "cylinder.con_rod_length", label: "Con-rod", unit: "mm", group: "Engine", format: mm },
  { key: "cylinder.compression_ratio", label: "Compression ratio", group: "Engine", format: f2 },
  // Combustion
  { key: "combustion.wiebe_a", label: "Wiebe a", group: "Combustion", format: f2 },
  { key: "combustion.wiebe_m", label: "Wiebe m", group: "Combustion", format: f2 },
  { key: "combustion.combustion_duration", label: "Duration", unit: "°CA", group: "Combustion", format: f1 },
  { key: "combustion.spark_advance", label: "Spark advance", unit: "°BTDC", group: "Combustion", format: f1 },
  { key: "combustion.ignition_delay", label: "Ignition delay", unit: "°CA", group: "Combustion", format: f1 },
  { key: "combustion.combustion_efficiency", label: "η_comb", group: "Combustion", format: f3 },
  { key: "combustion.q_lhv", label: "Q_LHV", unit: "J/kg", group: "Combustion", format: f0 },
  { key: "combustion.afr_target", label: "AFR target", group: "Combustion", format: f2 },
  // Intake
  { key: "restrictor.throat_diameter", label: "Restrictor Ø", unit: "mm", group: "Intake", format: mm },
  { key: "restrictor.discharge_coefficient", label: "Restrictor Cd", group: "Intake", format: f3 },
  { key: "plenum.volume", label: "Plenum V", unit: "L", group: "Intake", format: L },
  { key: "intake_valve.diameter", label: "Intake valve Ø", unit: "mm", group: "Intake", format: mm },
  { key: "intake_valve.max_lift", label: "Intake max lift", unit: "mm", group: "Intake", format: mm },
  { key: "intake_valve.open_angle", label: "Intake open", unit: "°", group: "Intake", format: f1 },
  { key: "intake_valve.close_angle", label: "Intake close", unit: "°", group: "Intake", format: f1 },
  // Exhaust
  { key: "exhaust_valve.diameter", label: "Exhaust valve Ø", unit: "mm", group: "Exhaust", format: mm },
  { key: "exhaust_valve.max_lift", label: "Exhaust max lift", unit: "mm", group: "Exhaust", format: mm },
  { key: "exhaust_valve.open_angle", label: "Exhaust open", unit: "°", group: "Exhaust", format: f1 },
  { key: "exhaust_valve.close_angle", label: "Exhaust close", unit: "°", group: "Exhaust", format: f1 },
  { key: "exhaust_collector.length", label: "Collector length", unit: "mm", group: "Exhaust", format: mm },
  { key: "exhaust_collector.diameter", label: "Collector Ø", unit: "mm", group: "Exhaust", format: mm },
  // Ambient & drivetrain
  { key: "p_ambient", label: "p_ambient", unit: "Pa", group: "Ambient & drivetrain", format: f0 },
  { key: "T_ambient", label: "T_ambient", unit: "K", group: "Ambient & drivetrain", format: f1 },
  { key: "drivetrain_efficiency", label: "Drivetrain η", group: "Ambient & drivetrain", format: f3 },
];

export const SDM26_GROUPS = [
  "Engine",
  "Combustion",
  "Intake",
  "Exhaust",
  "Ambient & drivetrain",
] as const;

export function getNested(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Used by ConfigScreen to show per-runner / per-primary array sections.
export interface PipeRow {
  index: number;
  length_mm: number;
  diameter_mm: number;
  diameter_out_mm: number | null;
  n_points: number;
  wall_t_K: number;
  name?: string;
}

export function extractPipeArray(raw: unknown, key: string): PipeRow[] {
  const arr = getNested(raw, key);
  if (!Array.isArray(arr)) return [];
  return arr.map((row, index) => {
    const r = row as Record<string, unknown>;
    return {
      index: index + 1,
      length_mm: ((r.length as number) ?? 0) * 1000,
      diameter_mm: ((r.diameter as number) ?? 0) * 1000,
      diameter_out_mm:
        r.diameter_out == null ? null : ((r.diameter_out as number) * 1000),
      n_points: (r.n_points as number) ?? 0,
      wall_t_K: (r.wall_temperature as number) ?? 0,
      name: r.name as string | undefined,
    };
  });
}
