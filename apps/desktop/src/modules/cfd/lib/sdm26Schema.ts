// Field metadata for the SDM26 V1 JSON config. Drives both the
// read-only summary (Phase 1) and the editable form (Phase 2). Keys
// reference dot-paths into LoadedConfig.raw.
//
// Unit convention: `min`, `max`, `step`, and stored values are all in
// SI base units (m, K, Pa, °CA, etc. — matching the V1 JSON on disk).
// `format` produces the display string; `formatInverse` parses a
// user-typed display value back to SI. The validator operates on the
// stored SI value, so range hints in the field UI render via `format`
// (e.g. "20.0 – 150.0 mm" not "0.020 – 0.150 m").

export type FieldType = "number" | "integer" | "text" | "select" | "boolean";

export interface FieldMeta {
  key: string;
  label: string;
  unit?: string;
  group: string;
  type: FieldType;
  format?: (v: unknown) => string;
  formatInverse?: (s: string) => unknown;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

// ---- formatters / inverses ----
const f3 = (v: unknown) => (typeof v === "number" ? v.toFixed(3) : String(v));
const f2 = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : String(v));
const f1 = (v: unknown) => (typeof v === "number" ? v.toFixed(1) : String(v));
const f0 = (v: unknown) => (typeof v === "number" ? v.toFixed(0) : String(v));
const expE1 = (v: unknown) => (typeof v === "number" ? v.toExponential(1) : String(v));

const mm = (v: unknown) => (typeof v === "number" ? (v * 1000).toFixed(1) : String(v));
const mmInv = (s: string) => (s.trim() === "" ? null : Number(s) / 1000);
const mmOptional = (v: unknown) => (v == null ? "—" : mm(v));
const mmOptionalInv = (s: string) => {
  const t = s.trim();
  if (t === "" || t === "—" || t === "null") return null;
  return Number(t) / 1000;
};
const L = (v: unknown) => (typeof v === "number" ? (v * 1000).toFixed(3) : String(v));
const Linv = (s: string) => (s.trim() === "" ? null : Number(s) / 1000);

const num = (v: unknown) => (typeof v === "number" ? String(v) : String(v));
const numInv = (s: string) => (s.trim() === "" ? null : Number(s));

const firingOrderFmt = (v: unknown) => (Array.isArray(v) ? v.join("-") : String(v));

// SDM26 main schema — used by ConfigScreen to render label/value rows.
export const SDM26_SCHEMA: FieldMeta[] = [
  // Engine
  { key: "name", label: "Name", group: "Engine", type: "text", required: true },
  { key: "n_cylinders", label: "Cylinders", group: "Engine", type: "integer", format: f0, min: 1, max: 16, required: true },
  { key: "firing_order", label: "Firing order", group: "Engine", type: "text", format: firingOrderFmt },
  { key: "firing_interval", label: "Firing interval", unit: "°CA", group: "Engine", type: "number", format: f1, min: 30, max: 720, required: true },
  { key: "cylinder.bore", label: "Bore", unit: "mm", group: "Engine", type: "number", format: mm, formatInverse: mmInv, min: 0.020, max: 0.150, required: true },
  { key: "cylinder.stroke", label: "Stroke", unit: "mm", group: "Engine", type: "number", format: mm, formatInverse: mmInv, min: 0.020, max: 0.200, required: true },
  { key: "cylinder.con_rod_length", label: "Con-rod", unit: "mm", group: "Engine", type: "number", format: mm, formatInverse: mmInv, min: 0.050, max: 0.300, required: true },
  { key: "cylinder.compression_ratio", label: "Compression ratio", group: "Engine", type: "number", format: f2, min: 4.0, max: 20.0, required: true },
  { key: "cylinder.n_intake_valves", label: "Intake valves / cyl", group: "Engine", type: "integer", format: f0, min: 1, max: 4 },
  { key: "cylinder.n_exhaust_valves", label: "Exhaust valves / cyl", group: "Engine", type: "integer", format: f0, min: 1, max: 4 },

  // Combustion
  { key: "combustion.wiebe_a", label: "Wiebe a", group: "Combustion", type: "number", format: f2, min: 1.0, max: 10.0, required: true },
  { key: "combustion.wiebe_m", label: "Wiebe m", group: "Combustion", type: "number", format: f2, min: 0.5, max: 5.0, required: true },
  { key: "combustion.combustion_duration", label: "Duration", unit: "°CA", group: "Combustion", type: "number", format: f1, min: 5, max: 180, required: true },
  { key: "combustion.spark_advance", label: "Spark advance", unit: "°BTDC", group: "Combustion", type: "number", format: f1, min: -20, max: 80, required: true },
  { key: "combustion.ignition_delay", label: "Ignition delay", unit: "°CA", group: "Combustion", type: "number", format: f1, min: 0, max: 30 },
  { key: "combustion.combustion_efficiency", label: "η_comb", group: "Combustion", type: "number", format: f3, min: 0.5, max: 1.0, required: true },
  { key: "combustion.q_lhv", label: "Q_LHV", unit: "J/kg", group: "Combustion", type: "number", format: f0, min: 1e7, max: 1e8, required: true },
  { key: "combustion.afr_stoich", label: "AFR stoich", group: "Combustion", type: "number", format: f2, min: 8, max: 25 },
  { key: "combustion.afr_target", label: "AFR target", group: "Combustion", type: "number", format: f2, min: 8, max: 25, required: true },

  // Intake
  { key: "restrictor.throat_diameter", label: "Restrictor Ø", unit: "mm", group: "Intake", type: "number", format: mm, formatInverse: mmInv, min: 0.005, max: 0.080, required: true },
  { key: "restrictor.discharge_coefficient", label: "Restrictor Cd", group: "Intake", type: "number", format: f3, min: 0.5, max: 1.0, required: true },
  { key: "restrictor.converging_half_angle", label: "Conv. half-angle", unit: "°", group: "Intake", type: "number", format: f1, min: 0, max: 45 },
  { key: "restrictor.diverging_half_angle", label: "Div. half-angle", unit: "°", group: "Intake", type: "number", format: f1, min: 0, max: 45 },
  { key: "plenum.volume", label: "Plenum V", unit: "L", group: "Intake", type: "number", format: L, formatInverse: Linv, min: 1e-5, max: 0.05, required: true },
  { key: "plenum.initial_pressure", label: "Plenum p_0", unit: "Pa", group: "Intake", type: "number", format: f0, min: 1e3, max: 5e5 },
  { key: "plenum.initial_temperature", label: "Plenum T_0", unit: "K", group: "Intake", type: "number", format: f1, min: 250, max: 500 },

  // Exhaust topology (synthetic key — handled specially by the reducer)
  { key: "__topology", label: "Topology", group: "Exhaust", type: "select",
    options: [
      { value: "4-1", label: "4-1 (single collector)" },
      { value: "4-2-1", label: "4-2-1 (with secondaries)" },
    ],
  },
  { key: "exhaust_collector.length", label: "Collector L", unit: "mm", group: "Exhaust", type: "number", format: mm, formatInverse: mmInv, min: 0.01, max: 2.0 },
  { key: "exhaust_collector.diameter", label: "Collector Ø", unit: "mm", group: "Exhaust", type: "number", format: mm, formatInverse: mmInv, min: 0.01, max: 0.200 },
  { key: "exhaust_collector.diameter_out", label: "Collector Ø out", unit: "mm", group: "Exhaust", type: "number", format: mmOptional, formatInverse: mmOptionalInv, min: 0.005, max: 0.200 },
  { key: "exhaust_collector.n_points", label: "Collector N cells", group: "Exhaust", type: "integer", format: f0, min: 5, max: 200 },
  { key: "exhaust_collector.wall_temperature", label: "Collector T wall", unit: "K", group: "Exhaust", type: "number", format: f0, min: 250, max: 1500 },

  // Ambient & drivetrain
  { key: "p_ambient", label: "p_ambient", unit: "Pa", group: "Ambient & drivetrain", type: "number", format: f0, min: 5e4, max: 2e5, required: true },
  { key: "T_ambient", label: "T_ambient", unit: "K", group: "Ambient & drivetrain", type: "number", format: f1, min: 200, max: 400, required: true },
  { key: "drivetrain_efficiency", label: "Drivetrain η", group: "Ambient & drivetrain", type: "number", format: f3, min: 0.1, max: 1.0, required: true },

  // Physics — dyno-validated model refinements (findings 0005/0006/0020/0021).
  // All optional: a config without the `physics` section runs the legacy
  // (Python-parity) models. The bundled SDM25/SDM26 ship with the validated
  // production values (RMSE 4.27 kW vs team dyno).
  { key: "physics.spark_advance_rpm_slope_deg_per_krpm", label: "MBT spark slope", unit: "°/krpm", group: "Physics", type: "number", format: f2, min: 0, max: 3 },
  { key: "physics.duration_rpm_exp", label: "Burn duration RPM exp", group: "Physics", type: "number", format: f2, min: 0, max: 0.8 },
  { key: "physics.restrictor_cd_mach_k", label: "Restrictor Mach-Cd k", group: "Physics", type: "number", format: f2, min: 0, max: 0.6 },
  { key: "physics.restrictor_loss_from_diffuser_geometry", label: "Diffuser loss (Idelchik)", group: "Physics", type: "boolean" },
  { key: "physics.intake_junction_borda_carnot", label: "Intake jct Borda-Carnot", group: "Physics", type: "boolean" },
  { key: "physics.fmep_c", label: "FMEP c (quadratic)", unit: "bar·s²/m²", group: "Physics", type: "number", format: expE1, min: 0, max: 0.005 },
];

export const SDM26_GROUPS = [
  "Engine",
  "Combustion",
  "Intake",
  "Exhaust",
  "Ambient & drivetrain",
  "Physics",
] as const;

// Valve sub-schema — used by ConfigScreen to render two valve cards
// (intake_valve.*, exhaust_valve.*). The cd_table field is rendered by
// CdTableField, not via this schema.
export const VALVE_FIELDS: FieldMeta[] = [
  { key: "diameter", label: "Ø", unit: "mm", group: "Valve", type: "number", format: mm, formatInverse: mmInv, min: 0.005, max: 0.060, required: true },
  { key: "max_lift", label: "Max lift", unit: "mm", group: "Valve", type: "number", format: mm, formatInverse: mmInv, min: 0.001, max: 0.030, required: true },
  { key: "open_angle", label: "Open angle", unit: "°", group: "Valve", type: "number", format: f1, min: -360, max: 720, required: true },
  { key: "close_angle", label: "Close angle", unit: "°", group: "Valve", type: "number", format: f1, min: -360, max: 720, required: true },
  { key: "seat_angle", label: "Seat angle", unit: "°", group: "Valve", type: "number", format: f1, min: 0, max: 90 },
];

// Pipe row sub-schema — used by PipeArrayField for intake_pipes,
// exhaust_primaries, exhaust_secondaries entries.
export const PIPE_FIELDS: FieldMeta[] = [
  { key: "name", label: "Name", group: "Pipe", type: "text" },
  { key: "length", label: "L", unit: "mm", group: "Pipe", type: "number", format: mm, formatInverse: mmInv, min: 0.01, max: 5.0, required: true },
  { key: "diameter", label: "Ø in", unit: "mm", group: "Pipe", type: "number", format: mm, formatInverse: mmInv, min: 0.005, max: 0.200, required: true },
  { key: "diameter_out", label: "Ø out", unit: "mm", group: "Pipe", type: "number", format: mmOptional, formatInverse: mmOptionalInv, min: 0.005, max: 0.200 },
  { key: "n_points", label: "N cells", group: "Pipe", type: "integer", format: f0, min: 5, max: 200, required: true },
  { key: "wall_temperature", label: "T wall", unit: "K", group: "Pipe", type: "number", format: f0, min: 250, max: 1500, required: true },
  { key: "roughness", label: "Roughness", unit: "m", group: "Pipe", type: "number", format: expE1, formatInverse: numInv, min: 0, max: 1e-3 },
];

// Default values for a fresh pipe row, by topology slot.
export const DEFAULT_INTAKE_PIPE = {
  name: "intake_runner",
  length: 0.245,
  diameter: 0.038,
  diameter_out: null,
  n_points: 30,
  wall_temperature: 325.0,
  roughness: 3e-5,
} as const;

export const DEFAULT_PRIMARY_PIPE = {
  name: "exhaust_primary",
  length: 0.308,
  diameter: 0.032,
  diameter_out: null,
  n_points: 30,
  wall_temperature: 650.0,
  roughness: 4.6e-5,
} as const;

export const DEFAULT_SECONDARY_PIPE = {
  name: "exhaust_secondary",
  length: 0.392,
  diameter: 0.038,
  diameter_out: null,
  n_points: 20,
  wall_temperature: 550.0,
  roughness: 4.6e-5,
} as const;

// Phase 1 helper carried forward unchanged for ConfigScreen's pipe tables.
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
        r.diameter_out == null ? null : (r.diameter_out as number) * 1000,
      n_points: (r.n_points as number) ?? 0,
      wall_t_K: (r.wall_temperature as number) ?? 0,
      name: r.name as string | undefined,
    };
  });
}

// Topology derived from the secondaries array; safe to call on any raw config.
export type Topology = "4-1" | "4-2-1";
export function deriveTopology(raw: unknown): Topology {
  const sec = getNested(raw, "exhaust_secondaries");
  return Array.isArray(sec) && sec.length > 0 ? "4-2-1" : "4-1";
}
