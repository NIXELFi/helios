// Production knob-set presets for the CFD UI.
//
// These are the recommendations from the physics agent loop work
// (`physics_findings/SESSION_HANDOFF.md` §2 + findings 0005-0024).
// Each preset is a list of {path, value} overrides applied via the
// backend's `apply_override` before the engine runs. Defaults preserve
// parity with the simulator's bit-exact baseline.

import type { ParameterOverride } from "../state/types";

export interface Preset {
  /** Stable id (used as React key + selected state). */
  id: string;
  /** Short label shown in the UI dropdown. */
  label: string;
  /** Tagline shown under the label / on the chip. */
  tagline: string;
  /** Longer description shown in the preset details panel. */
  description: string;
  /** Findings that justify each knob (linked in the UI). */
  findings: string[];
  /** Recommended for which engine geometry. */
  recommendedFor: "all" | "sdm25-like" | "sdm26-like";
  /** Concrete overrides applied via apply_override. */
  overrides: ParameterOverride[];
}

/** No overrides — runs the simulator with the JSON config exactly as loaded.
 *  Useful as a "reset" / parity-preserving option. */
export const PRESET_NONE: Preset = {
  id: "none",
  label: "None (config defaults)",
  tagline: "Bit-exact JSON config; no opt-in physics",
  description:
    "Runs the simulator with the loaded JSON config exactly as-is. " +
    "All opt-in physics knobs (Borda-Carnot junction, Mach-Cd, MBT map, " +
    "Wiebe RPM scaling, FMEP_c, etc.) stay at their parity-preserving " +
    "defaults. Useful for parity baselines and pre-physics-loop comparisons.",
  findings: [],
  recommendedFor: "all",
  overrides: [],
};

/** Option B from finding 0021 — the current recommended production knob set.
 *  Validated against the team's real Dynojet dyno data (finding 0018). */
export const PRESET_OPTION_B: Preset = {
  id: "option-b",
  label: "Option B — Production knob set",
  tagline:
    "Literature-derived physics; -32% RMSE on SDM26, -24% on SDM25 vs main",
  description:
    "Literature-derived opt-in physics validated against the team's real " +
    "Dynojet chassis dyno (findings 0005-0022). Closes ~30% RMSE on both " +
    "engines in the meaningful WOT band (6-13 kRPM) compared to the bare " +
    "simulator. Each knob is documented in physics_findings/. Mach-Cd " +
    "k = 0.10 is validated within 15% by the analytic Shapiro+Idelchik " +
    "Cd(M) model (finding 0022).",
  findings: ["0005", "0006", "0018", "0020", "0021", "0022"],
  recommendedFor: "all",
  overrides: [
    // 0005 — Borda-Carnot intake junction loss inside the mass residual
    { path: "intake_junction_borda_carnot", value: 1.0 },
    { path: "intake_junction_loss_coef", value: 1.0 },
    // 0006 — Restrictor diffuser loss derived from JSON diverging_half_angle
    { path: "restrictor_loss_from_diffuser_geometry", value: 1.0 },
    // 0021 — Mach-Cd correction at the restrictor (NASA TM X-1570 scaled
    //         for contoured-nozzle geometry; analytic validation 0022)
    { path: "restrictor_cd_mach_k", value: 0.10 },
    // 0006 — RPM-dependent spark advance (Bonatesta MBT map)
    { path: "spark_advance_rpm_slope_deg_per_krpm", value: 1.5 },
    // 0006 — RPM-dependent Wiebe burn duration (Bonatesta N^p, p≈0.4)
    { path: "duration_rpm_exp", value: 0.4 },
    // 0020 — FMEP quadratic coefficient at Heywood Tab 13.3 motorcycle midpoint
    //         (was 0.003 = 3× Heywood ceiling pre-0020)
    { path: "fmep_c", value: 0.00075 },
  ],
};

/** Option B plus two-zone v2 (finding 0016). Better fit on engines with
 *  SDM25-like geometry (long 4-1 exhaust); slightly worse on SDM26-like. */
export const PRESET_OPTION_B_TWO_ZONE: Preset = {
  id: "option-b-two-zone",
  label: "Option B + Two-zone v2",
  tagline: "Recommended for SDM25-like geometry (long 4-1 exhaust)",
  description:
    "Option B production knob set + opt-in two-zone combustion model with " +
    "the c_v-weighted γ_eff fix and R-weighted volume-fraction fix " +
    "(finding 0016 v2). Improves SDM25 WOT RMSE by -21% (closes most of " +
    "the high-RPM under-prediction) at the cost of slight over-prediction " +
    "in the SDM26 peak band. Recommended for engines with long exhaust " +
    "primaries / 4-1 collectors.",
  findings: ["0016", "0021"],
  recommendedFor: "sdm25-like",
  overrides: [
    ...PRESET_OPTION_B.overrides,
    { path: "two_zone_enabled", value: 1.0 },
    { path: "two_zone_gamma_cv_weighted", value: 1.0 },
  ],
};

/** Option B plus WENO5 solver. Implementation kept after finding 0023
 *  showed it had negligible impact on real-dyno fit, but available for
 *  future investigations / engines outside the CBR600RR class. */
export const PRESET_OPTION_B_WENO5: Preset = {
  id: "option-b-weno5",
  label: "Option B + WENO5 solver (experimental)",
  tagline: "5th-order pipe solver; ~60% slower; minimal benefit on real dyno",
  description:
    "Option B + opt-in WENO5 + SSP-RK2 pipe solver instead of MUSCL-Hancock " +
    "(finding 0023). Implementation is correct and parity-preserving but " +
    "gives essentially no change on real-dyno fit for CBR600RR-class " +
    "engines (the MUSCL exhaust-damping hypothesis didn't survive against " +
    "the real dyno). Costs ≈ 60% more per step. Use for shock-tube " +
    "experiments or larger engines where wave damping may matter.",
  findings: ["0023"],
  recommendedFor: "all",
  overrides: [
    ...PRESET_OPTION_B.overrides,
    { path: "use_weno5_in_pipes", value: 1.0 },
  ],
};

export const PRESETS: Preset[] = [
  PRESET_NONE,
  PRESET_OPTION_B,
  PRESET_OPTION_B_TWO_ZONE,
  PRESET_OPTION_B_WENO5,
];

/** Default preset selected for new studies. */
export const DEFAULT_PRESET_ID = PRESET_OPTION_B.id;

export function findPreset(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESET_NONE;
}
