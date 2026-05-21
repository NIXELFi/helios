// CFD config templates. SDM25 + SDM26 are imported directly from the
// bundled Tauri resources (Vite handles JSON imports natively). Blank
// is a hand-crafted minimal-valid SDM26 config used as a clean slate
// for new engines.

// Source-of-truth lives at apps/desktop/src-tauri/resources/cfd/configs/.
// These copies in the frontend tree are read-only template seeds; the
// runtime "Load example" flow still loads from the Tauri resource dir.
import sdm26Raw from "./sdm26.json";
import sdm25Raw from "./sdm25.json";

export interface Template {
  id: string;
  name: string;
  description: string;
  raw: Record<string, unknown>;
}

// Deep-freeze a JSON-shaped value so the same template object can be
// re-used across loadTemplate calls without leaking mutations.
// Best-effort: silently skips properties that can't be frozen (some
// Vite JSON imports use getters that may not be reconfigurable).
function deepFreeze<T>(o: T): T {
  if (o == null || typeof o !== "object") return o;
  try { Object.freeze(o); } catch { /* skip */ }
  try {
    for (const k of Object.keys(o)) {
      deepFreeze((o as Record<string, unknown>)[k]);
    }
  } catch { /* skip */ }
  return o;
}

const BLANK_RAW: Record<string, unknown> = {
  name: "New engine",
  n_cylinders: 4,
  firing_order: [1, 2, 4, 3],
  firing_interval: 180.0,
  cylinder: {
    bore: 0.080,
    stroke: 0.080,
    con_rod_length: 0.130,
    compression_ratio: 10.0,
    n_intake_valves: 2,
    n_exhaust_valves: 2,
  },
  intake_valve: {
    diameter: 0.030,
    max_lift: 0.010,
    open_angle: 350.0,
    close_angle: 580.0,
    seat_angle: 45.0,
    cd_table: [
      [0.05, 0.20],
      [0.10, 0.40],
      [0.15, 0.50],
      [0.20, 0.55],
      [0.25, 0.57],
      [0.30, 0.57],
    ],
  },
  exhaust_valve: {
    diameter: 0.025,
    max_lift: 0.009,
    open_angle: 140.0,
    close_angle: 365.0,
    seat_angle: 45.0,
    cd_table: [
      [0.05, 0.18],
      [0.10, 0.35],
      [0.15, 0.46],
      [0.20, 0.52],
      [0.25, 0.54],
      [0.30, 0.55],
    ],
  },
  intake_pipes: [
    { name: "intake_runner_1", length: 0.250, diameter: 0.040, diameter_out: null, n_points: 30, wall_temperature: 325.0, roughness: 3e-5 },
    { name: "intake_runner_2", length: 0.250, diameter: 0.040, diameter_out: null, n_points: 30, wall_temperature: 325.0, roughness: 3e-5 },
    { name: "intake_runner_3", length: 0.250, diameter: 0.040, diameter_out: null, n_points: 30, wall_temperature: 325.0, roughness: 3e-5 },
    { name: "intake_runner_4", length: 0.250, diameter: 0.040, diameter_out: null, n_points: 30, wall_temperature: 325.0, roughness: 3e-5 },
  ],
  exhaust_primaries: [
    { name: "exhaust_primary_1", length: 0.300, diameter: 0.035, diameter_out: null, n_points: 30, wall_temperature: 650.0, roughness: 4.6e-5 },
    { name: "exhaust_primary_2", length: 0.300, diameter: 0.035, diameter_out: null, n_points: 30, wall_temperature: 650.0, roughness: 4.6e-5 },
    { name: "exhaust_primary_3", length: 0.300, diameter: 0.035, diameter_out: null, n_points: 30, wall_temperature: 650.0, roughness: 4.6e-5 },
    { name: "exhaust_primary_4", length: 0.300, diameter: 0.035, diameter_out: null, n_points: 30, wall_temperature: 650.0, roughness: 4.6e-5 },
  ],
  exhaust_secondaries: [],
  exhaust_collector: {
    name: "exhaust_collector", length: 0.150, diameter: 0.050, diameter_out: null, n_points: 20, wall_temperature: 500.0, roughness: 4.6e-5,
  },
  combustion: {
    wiebe_a: 5.0,
    wiebe_m: 2.0,
    combustion_duration: 50.0,
    spark_advance: 25.0,
    ignition_delay: 7.0,
    combustion_efficiency: 0.96,
    q_lhv: 44000000.0,
    afr_stoich: 14.7,
    afr_target: 13.1,
  },
  restrictor: {
    throat_diameter: 0.020,
    discharge_coefficient: 0.95,
    converging_half_angle: 12.0,
    diverging_half_angle: 6.0,
  },
  plenum: {
    volume: 0.0015,
    initial_pressure: 101325.0,
    initial_temperature: 300.0,
  },
  p_ambient: 101325.0,
  T_ambient: 300.0,
  drivetrain_efficiency: 0.85,
};

deepFreeze(BLANK_RAW);
deepFreeze(sdm26Raw);
deepFreeze(sdm25Raw);

export const TEMPLATES: ReadonlyArray<Template> = [
  {
    id: "sdm26",
    name: "SDM26 — Honda CBR600RR (FSAE)",
    description: "Phase-F-calibrated CBR600RR I4 with 20 mm FSAE restrictor + 4-2-1 exhaust. Default starting point.",
    raw: sdm26Raw as Record<string, unknown>,
  },
  {
    id: "sdm25",
    name: "SDM25 — Honda CBR600RR (legacy)",
    description: "Pre-Phase-F SDM25 calibration. Same engine, older tuning; useful for comparing against Python diagnostics.",
    raw: sdm25Raw as Record<string, unknown>,
  },
  {
    id: "blank",
    name: "Blank engine",
    description: "Minimal valid SDM26 with sensible defaults. Start here when building a new engine from scratch.",
    raw: BLANK_RAW,
  },
];

/// Returns a fresh deep copy of the template (so the editor can mutate
/// it without touching the frozen template object).
export function materializeTemplate(t: Template): Record<string, unknown> {
  return structuredClone(t.raw) as Record<string, unknown>;
}
