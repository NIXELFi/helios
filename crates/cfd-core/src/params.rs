//! Parameter introspection for SDM26Config.
//!
//! Two halves:
//!  1. `enumerate_schema(cfg)` — hand-written list of every optimizable
//!     numeric leaf, grouped by UI panel (Geometry, Intake, ...).
//!  2. `apply_override(cfg, path, value)` — write a value to one of those
//!     paths. Paths use the **flat** SDM26Config field names. Array
//!     fields (e.g. `runner_lengths`) accept an optional `[N]` index
//!     suffix; without it the scalar default and every per-cylinder
//!     element are both written so downstream consumers see one
//!     consistent value.
//!
//! Names match `crates/engine-sim/src/model/sdm26.rs` 1:1 — no remapping.

use engine_sim::model::sdm26::SDM26Config;
use serde::{Deserialize, Serialize};

/// Whether a parameter is a scalar or a per-cylinder array.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ParameterType {
    Scalar,
    Array,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterMeta {
    pub path: String,
    pub kind: ParameterType,
    /// For Array: number of elements (typically n_cylinders). For Scalar: 1.
    pub array_len: usize,
    pub unit: String,
    pub default: f64,
    pub suggested_min: f64,
    pub suggested_max: f64,
    /// Group label for the UI (e.g. "Intake", "Combustion").
    pub group: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ParameterError {
    #[error("unknown parameter path: {0}")]
    UnknownPath(String),
    #[error("array index {idx} out of bounds (len={len}) for path {path}")]
    IndexOutOfBounds {
        path: String,
        idx: usize,
        len: usize,
    },
}

/// Build the full list of optimizable parameter metadata from a loaded
/// SDM26Config. Array bounds use `cfg.n_cylinders` so the UI knows how
/// many indexable slots exist.
pub fn enumerate_schema(cfg: &SDM26Config) -> Vec<ParameterMeta> {
    use ParameterType::*;
    let n_cyl = cfg.n_cylinders.max(1);

    // small builder so the table below is readable
    fn m(
        path: &str,
        kind: ParameterType,
        array_len: usize,
        unit: &str,
        default: f64,
        suggested_min: f64,
        suggested_max: f64,
        group: &str,
    ) -> ParameterMeta {
        ParameterMeta {
            path: path.to_string(),
            kind,
            array_len,
            unit: unit.to_string(),
            default,
            suggested_min,
            suggested_max,
            group: group.to_string(),
        }
    }

    vec![
        // --- Geometry ---
        m("bore", Scalar, 1, "m", cfg.bore, 0.05, 0.12, "Geometry"),
        m("stroke", Scalar, 1, "m", cfg.stroke, 0.04, 0.10, "Geometry"),
        m("con_rod", Scalar, 1, "m", cfg.con_rod, 0.08, 0.20, "Geometry"),
        m("cr", Scalar, 1, "ratio", cfg.cr, 8.0, 16.0, "Geometry"),

        // --- Intake runners (per-cylinder array, uniform-or-targeted) ---
        m("runner_length", Array, n_cyl, "m", cfg.runner_length, 0.10, 0.50, "Intake"),
        m("runner_diameter_in", Array, n_cyl, "m", cfg.runner_diameter_in, 0.020, 0.045, "Intake"),
        m(
            "runner_diameter_out",
            Array,
            n_cyl,
            "m",
            cfg.runner_diameter_out.unwrap_or(cfg.runner_diameter_in),
            0.020,
            0.045,
            "Intake",
        ),
        m("runner_n_cells", Scalar, 1, "-", cfg.runner_n_cells as f64, 10.0, 80.0, "Intake"),
        m("runner_wall_t", Scalar, 1, "K", cfg.runner_wall_t, 280.0, 400.0, "Intake"),

        // --- Plenum ---
        m("plenum_volume", Scalar, 1, "m^3", cfg.plenum_volume, 0.0005, 0.005, "Intake"),
        m("plenum_length", Scalar, 1, "m", cfg.plenum_length, 0.05, 0.30, "Intake"),
        m("plenum_n_cells", Scalar, 1, "-", cfg.plenum_n_cells as f64, 10.0, 60.0, "Intake"),
        m("plenum_wall_t", Scalar, 1, "K", cfg.plenum_wall_t, 280.0, 400.0, "Intake"),
        m("intake_junction_loss_coef", Scalar, 1, "-", cfg.intake_junction_loss_coef, 0.0, 1.0, "Intake"),
        m("intake_junction_borda_carnot", Scalar, 1, "bool", if cfg.intake_junction_borda_carnot { 1.0 } else { 0.0 }, 0.0, 1.0, "Intake"),
        m("exhaust_junction_loss_coef", Scalar, 1, "-", cfg.exhaust_junction_loss_coef, 0.0, 1.0, "Exhaust"),
        m("exhaust_junction_borda_carnot", Scalar, 1, "bool", if cfg.exhaust_junction_borda_carnot { 1.0 } else { 0.0 }, 0.0, 1.0, "Exhaust"),
        m("spark_advance_rpm_slope_deg_per_krpm", Scalar, 1, "deg/krpm", cfg.spark_advance_rpm_slope_deg_per_krpm, 0.0, 3.0, "Combustion"),
        m("spark_advance_rpm_ref", Scalar, 1, "RPM", cfg.spark_advance_rpm_ref, 4000.0, 13000.0, "Combustion"),
        m("duration_rpm_exp", Scalar, 1, "-", cfg.duration_rpm_exp, 0.0, 0.8, "Combustion"),
        m("duration_rpm_ref", Scalar, 1, "RPM", cfg.duration_rpm_ref, 4000.0, 13000.0, "Combustion"),
        m("wiebe_a_rpm_exp", Scalar, 1, "-", cfg.wiebe_a_rpm_exp, 0.0, 0.8, "Combustion"),
        m("wiebe_a_rpm_ref", Scalar, 1, "RPM", cfg.wiebe_a_rpm_ref, 4000.0, 13000.0, "Combustion"),
        m("exhaust_collector_reflection_coef", Scalar, 1, "-", cfg.exhaust_collector_reflection_coef, 0.0, 1.0, "Exhaust"),
        m("restrictor_loss_from_diffuser_geometry", Scalar, 1, "bool", if cfg.restrictor_loss_from_diffuser_geometry { 1.0 } else { 0.0 }, 0.0, 1.0, "Restrictor"),
        m("restrictor_diverging_half_angle_deg", Scalar, 1, "deg", cfg.restrictor_diverging_half_angle_deg, 3.0, 30.0, "Restrictor"),
        m("restrictor_cd_mach_k", Scalar, 1, "-", cfg.restrictor_cd_mach_k, 0.0, 0.6, "Restrictor"),
        // Missing-from-overrides combustion flags, exposed for breakdown
        // probing (0009 finding). All three are SDM26Config fields that
        // existed but had no apply_override entry — sweep studies that
        // tried to toggle them got "unknown parameter path" and silently
        // ran with defaults (or errored).
        m("afr_eta_enabled", Scalar, 1, "bool", if cfg.afr_eta_enabled { 1.0 } else { 0.0 }, 0.0, 1.0, "Combustion"),
        m("tumble_burn_factor", Scalar, 1, "-", cfg.tumble_burn_factor, 0.0, 1.0, "Combustion"),
        m("two_zone_enabled", Scalar, 1, "bool", if cfg.two_zone_enabled { 1.0 } else { 0.0 }, 0.0, 1.0, "Combustion"),

        // --- Restrictor ---
        m("restrictor_throat_diameter", Scalar, 1, "m", cfg.restrictor_throat_diameter, 0.015, 0.025, "Restrictor"),
        m("restrictor_cd", Scalar, 1, "-", cfg.restrictor_cd, 0.70, 0.99, "Restrictor"),
        m("restrictor_loss_coef", Scalar, 1, "-", cfg.restrictor_loss_coef, 0.0, 1.0, "Restrictor"),

        // --- Exhaust primaries (per-cylinder array) ---
        m("primary_length", Array, n_cyl, "m", cfg.primary_length, 0.20, 0.80, "Exhaust"),
        m("primary_diameter_in", Array, n_cyl, "m", cfg.primary_diameter_in, 0.025, 0.055, "Exhaust"),
        m(
            "primary_diameter_out",
            Array,
            n_cyl,
            "m",
            cfg.primary_diameter_out.unwrap_or(cfg.primary_diameter_in),
            0.025,
            0.055,
            "Exhaust",
        ),
        m("primary_n_cells", Scalar, 1, "-", cfg.primary_n_cells as f64, 10.0, 80.0, "Exhaust"),
        m("primary_wall_t", Scalar, 1, "K", cfg.primary_wall_t, 600.0, 1200.0, "Exhaust"),

        // --- Exhaust secondaries (4-2-1: array of length 2; we expose n_cyl/2 = up to 2) ---
        m("secondary_length", Array, n_cyl.min(2).max(1), "m", cfg.secondary_length, 0.15, 0.80, "Exhaust"),
        m("secondary_diameter_in", Array, n_cyl.min(2).max(1), "m", cfg.secondary_diameter_in, 0.030, 0.070, "Exhaust"),
        m(
            "secondary_diameter_out",
            Array,
            n_cyl.min(2).max(1),
            "m",
            cfg.secondary_diameter_out.unwrap_or(cfg.secondary_diameter_in),
            0.030,
            0.070,
            "Exhaust",
        ),
        m("secondary_n_cells", Scalar, 1, "-", cfg.secondary_n_cells as f64, 10.0, 60.0, "Exhaust"),
        m("secondary_wall_t", Scalar, 1, "K", cfg.secondary_wall_t, 500.0, 1100.0, "Exhaust"),

        // --- Collector (scalar pipe) ---
        m("collector_length", Scalar, 1, "m", cfg.collector_length, 0.05, 0.40, "Exhaust"),
        m("collector_diameter_in", Scalar, 1, "m", cfg.collector_diameter_in, 0.030, 0.080, "Exhaust"),
        m(
            "collector_diameter_out",
            Scalar,
            1,
            "m",
            cfg.collector_diameter_out.unwrap_or(cfg.collector_diameter_in),
            0.030,
            0.080,
            "Exhaust",
        ),
        m("collector_n_cells", Scalar, 1, "-", cfg.collector_n_cells as f64, 10.0, 60.0, "Exhaust"),
        m("collector_wall_t", Scalar, 1, "K", cfg.collector_wall_t, 500.0, 1100.0, "Exhaust"),

        // --- Ambient ---
        m("p_ambient", Scalar, 1, "Pa", cfg.p_ambient, 80_000.0, 105_000.0, "Ambient"),
        m("t_ambient", Scalar, 1, "K", cfg.t_ambient, 270.0, 320.0, "Ambient"),

        // --- Combustion ---
        m("wiebe_a", Scalar, 1, "-", cfg.wiebe_a, 2.0, 10.0, "Combustion"),
        m("wiebe_m", Scalar, 1, "-", cfg.wiebe_m, 1.5, 4.0, "Combustion"),
        m("combustion_duration", Scalar, 1, "deg", cfg.combustion_duration, 20.0, 80.0, "Combustion"),
        m("spark_advance", Scalar, 1, "deg", cfg.spark_advance, 5.0, 45.0, "Combustion"),
        m("ignition_delay", Scalar, 1, "deg", cfg.ignition_delay, 0.0, 20.0, "Combustion"),
        m("eta_comb", Scalar, 1, "-", cfg.eta_comb, 0.85, 1.00, "Combustion"),
        m("q_lhv", Scalar, 1, "J/kg", cfg.q_lhv, 40.0e6, 48.0e6, "Combustion"),
        m("afr_target", Scalar, 1, "-", cfg.afr_target, 11.5, 15.0, "Combustion"),
        m("t_wall_cylinder", Scalar, 1, "K", cfg.t_wall_cylinder, 350.0, 550.0, "Combustion"),
        m("woschni_c1_gas_exchange", Scalar, 1, "-", cfg.woschni_c1_gas_exchange, 1.0, 10.0, "Combustion"),
        m("woschni_c1_compression", Scalar, 1, "-", cfg.woschni_c1_compression, 1.0, 6.0, "Combustion"),
        m("woschni_c1_combustion", Scalar, 1, "-", cfg.woschni_c1_combustion, 1.0, 6.0, "Combustion"),
        m("woschni_c2_combustion", Scalar, 1, "-", cfg.woschni_c2_combustion, 0.0, 1.0e-2, "Combustion"),

        // --- Friction (Chen-Flynn FMEP) ---
        // fmep_bar = fmep_a + fmep_b * sp + fmep_c * sp^2, sp = mean piston speed.
        // Heywood Tab 13.3 SI typical: (0.4-0.8, 0.04-0.05, 0.002-0.005).
        // See physics_findings/0002-fmep-b-vs-heywood-typical/.
        m("fmep_a", Scalar, 1, "bar", cfg.fmep_a, 0.3, 0.8, "Friction"),
        m("fmep_b", Scalar, 1, "bar*s/m", cfg.fmep_b, 0.02, 0.15, "Friction"),
        m("fmep_c", Scalar, 1, "bar*s^2/m^2", cfg.fmep_c, 0.001, 0.006, "Friction"),

        // --- Valves ---
        m("intake_valve_diameter", Scalar, 1, "m", cfg.intake_valve_diameter, 0.020, 0.040, "Valves"),
        m("intake_valve_max_lift", Scalar, 1, "m", cfg.intake_valve_max_lift, 0.005, 0.014, "Valves"),
        m("intake_valve_open_angle", Scalar, 1, "deg", cfg.intake_valve_open_angle, 300.0, 380.0, "Valves"),
        m("intake_valve_close_angle", Scalar, 1, "deg", cfg.intake_valve_close_angle, 540.0, 620.0, "Valves"),
        m("intake_valve_seat_angle", Scalar, 1, "deg", cfg.intake_valve_seat_angle, 30.0, 60.0, "Valves"),
        m("exhaust_valve_diameter", Scalar, 1, "m", cfg.exhaust_valve_diameter, 0.015, 0.035, "Valves"),
        m("exhaust_valve_max_lift", Scalar, 1, "m", cfg.exhaust_valve_max_lift, 0.005, 0.014, "Valves"),
        m("exhaust_valve_open_angle", Scalar, 1, "deg", cfg.exhaust_valve_open_angle, 100.0, 180.0, "Valves"),
        m("exhaust_valve_close_angle", Scalar, 1, "deg", cfg.exhaust_valve_close_angle, 330.0, 410.0, "Valves"),
        m("exhaust_valve_seat_angle", Scalar, 1, "deg", cfg.exhaust_valve_seat_angle, 30.0, 60.0, "Valves"),

        // --- Drivetrain ---
        m("drivetrain_efficiency", Scalar, 1, "-", cfg.drivetrain_efficiency, 0.80, 0.95, "Drivetrain"),

        // --- Numerics ---
        m("cfl", Scalar, 1, "-", cfg.cfl, 0.30, 0.95, "Numerics"),
    ]
}

// ---------------- apply_override ----------------

/// Parse an optional `[N]` index suffix. Returns (base_path, index).
fn parse_array_index(path: &str) -> (&str, Option<usize>) {
    if let Some(open) = path.rfind('[') {
        if let Some(close) = path.rfind(']') {
            if close == path.len() - 1 && close > open {
                if let Ok(i) = path[open + 1..close].parse::<usize>() {
                    return (&path[..open], Some(i));
                }
            }
        }
    }
    (path, None)
}

/// Materialize a `None` per-cylinder array as `vec![scalar_default; n]`,
/// then set element `idx` to `value`. If the array is already `Some`,
/// just write the element. Errors if the array length doesn't cover
/// `idx`.
fn set_or_init_array_element(
    opt: &mut Option<Vec<f64>>,
    scalar_default: f64,
    n_cyl: usize,
    idx: usize,
    value: f64,
    path: &str,
) -> Result<(), ParameterError> {
    let arr = opt.get_or_insert_with(|| vec![scalar_default; n_cyl]);
    if idx >= arr.len() {
        return Err(ParameterError::IndexOutOfBounds {
            path: path.to_string(),
            idx,
            len: arr.len(),
        });
    }
    arr[idx] = value;
    Ok(())
}

/// Variant for the `runner_diameters_out`-style `Option<Vec<Option<f64>>>` shape.
fn set_or_init_array_element_optopt(
    opt: &mut Option<Vec<Option<f64>>>,
    scalar_default: f64,
    n_cyl: usize,
    idx: usize,
    value: f64,
    path: &str,
) -> Result<(), ParameterError> {
    let arr = opt.get_or_insert_with(|| vec![Some(scalar_default); n_cyl]);
    if idx >= arr.len() {
        return Err(ParameterError::IndexOutOfBounds {
            path: path.to_string(),
            idx,
            len: arr.len(),
        });
    }
    arr[idx] = Some(value);
    Ok(())
}

/// Apply a single override: `path = value`. `path` may include `[N]`
/// suffix for per-cylinder array targeting. For Array fields without an
/// index, both the scalar default and (if present) every element of the
/// per-cylinder Vec are written so the SDM26 spec accessors observe a
/// single coherent value.
pub fn apply_override(
    cfg: &mut SDM26Config,
    path: &str,
    value: f64,
) -> Result<(), ParameterError> {
    let (base, index) = parse_array_index(path);
    let n_cyl = cfg.n_cylinders.max(1);

    // u32-typed cell counts: round f64 -> usize.
    let to_usize = |v: f64| -> usize { v.round().max(0.0) as usize };

    match base {
        // Geometry
        "bore" => cfg.bore = value,
        "stroke" => cfg.stroke = value,
        "con_rod" => cfg.con_rod = value,
        "cr" => cfg.cr = value,

        // Intake runners
        "runner_length" => {
            if let Some(i) = index {
                let scalar = cfg.runner_length;
                set_or_init_array_element(&mut cfg.runner_lengths, scalar, n_cyl, i, value, path)?;
            } else {
                cfg.runner_length = value;
                if let Some(arr) = cfg.runner_lengths.as_mut() {
                    for v in arr.iter_mut() {
                        *v = value;
                    }
                }
            }
        }
        "runner_diameter_in" => {
            if let Some(i) = index {
                let scalar = cfg.runner_diameter_in;
                set_or_init_array_element(
                    &mut cfg.runner_diameters_in,
                    scalar,
                    n_cyl,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.runner_diameter_in = value;
                if let Some(arr) = cfg.runner_diameters_in.as_mut() {
                    for v in arr.iter_mut() {
                        *v = value;
                    }
                }
            }
        }
        "runner_diameter_out" => {
            if let Some(i) = index {
                let scalar = cfg.runner_diameter_out.unwrap_or(cfg.runner_diameter_in);
                set_or_init_array_element_optopt(
                    &mut cfg.runner_diameters_out,
                    scalar,
                    n_cyl,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.runner_diameter_out = Some(value);
                if let Some(arr) = cfg.runner_diameters_out.as_mut() {
                    for v in arr.iter_mut() {
                        *v = Some(value);
                    }
                }
            }
        }
        "runner_n_cells" => cfg.runner_n_cells = to_usize(value),
        "runner_wall_t" => {
            cfg.runner_wall_t = value;
            if let Some(arr) = cfg.runner_wall_ts.as_mut() {
                for v in arr.iter_mut() {
                    *v = value;
                }
            }
        }

        // Plenum
        "plenum_volume" => cfg.plenum_volume = value,
        "plenum_length" => cfg.plenum_length = value,
        "plenum_n_cells" => cfg.plenum_n_cells = to_usize(value),
        "plenum_wall_t" => cfg.plenum_wall_t = value,
        "intake_junction_loss_coef" => cfg.intake_junction_loss_coef = value,
        "intake_junction_borda_carnot" => cfg.intake_junction_borda_carnot = value != 0.0,
        "exhaust_junction_loss_coef" => cfg.exhaust_junction_loss_coef = value,
        "exhaust_junction_borda_carnot" => cfg.exhaust_junction_borda_carnot = value != 0.0,
        "spark_advance_rpm_slope_deg_per_krpm" => cfg.spark_advance_rpm_slope_deg_per_krpm = value,
        "spark_advance_rpm_ref" => cfg.spark_advance_rpm_ref = value,
        "duration_rpm_exp" => cfg.duration_rpm_exp = value,
        "duration_rpm_ref" => cfg.duration_rpm_ref = value,
        "wiebe_a_rpm_exp" => cfg.wiebe_a_rpm_exp = value,
        "wiebe_a_rpm_ref" => cfg.wiebe_a_rpm_ref = value,
        "exhaust_collector_reflection_coef" => cfg.exhaust_collector_reflection_coef = value,
        "restrictor_loss_from_diffuser_geometry" => cfg.restrictor_loss_from_diffuser_geometry = value != 0.0,
        "restrictor_diverging_half_angle_deg" => cfg.restrictor_diverging_half_angle_deg = value,
        "restrictor_cd_mach_k" => cfg.restrictor_cd_mach_k = value,
        "afr_eta_enabled" => cfg.afr_eta_enabled = value != 0.0,
        "tumble_burn_factor" => cfg.tumble_burn_factor = value,
        "two_zone_enabled" => cfg.two_zone_enabled = value != 0.0,

        // Restrictor
        "restrictor_throat_diameter" => cfg.restrictor_throat_diameter = value,
        "restrictor_cd" => cfg.restrictor_cd = value,
        "restrictor_loss_coef" => cfg.restrictor_loss_coef = value,

        // Exhaust primaries
        "primary_length" => {
            if let Some(i) = index {
                let scalar = cfg.primary_length;
                set_or_init_array_element(
                    &mut cfg.primary_lengths,
                    scalar,
                    n_cyl,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.primary_length = value;
                if let Some(arr) = cfg.primary_lengths.as_mut() {
                    for v in arr.iter_mut() {
                        *v = value;
                    }
                }
            }
        }
        "primary_diameter_in" => {
            if let Some(i) = index {
                let scalar = cfg.primary_diameter_in;
                set_or_init_array_element(
                    &mut cfg.primary_diameters_in,
                    scalar,
                    n_cyl,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.primary_diameter_in = value;
                if let Some(arr) = cfg.primary_diameters_in.as_mut() {
                    for v in arr.iter_mut() {
                        *v = value;
                    }
                }
            }
        }
        "primary_diameter_out" => {
            if let Some(i) = index {
                let scalar = cfg.primary_diameter_out.unwrap_or(cfg.primary_diameter_in);
                set_or_init_array_element_optopt(
                    &mut cfg.primary_diameters_out,
                    scalar,
                    n_cyl,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.primary_diameter_out = Some(value);
                if let Some(arr) = cfg.primary_diameters_out.as_mut() {
                    for v in arr.iter_mut() {
                        *v = Some(value);
                    }
                }
            }
        }
        "primary_n_cells" => cfg.primary_n_cells = to_usize(value),
        "primary_wall_t" => {
            cfg.primary_wall_t = value;
            if let Some(arr) = cfg.primary_wall_ts.as_mut() {
                for v in arr.iter_mut() {
                    *v = value;
                }
            }
        }

        // Exhaust secondaries (typically array length 2 in 4-2-1)
        "secondary_length" => {
            if let Some(i) = index {
                let scalar = cfg.secondary_length;
                // secondaries array is sized to 2 for 4-2-1; fall back to n_cyl if user constructed it that way.
                let n = cfg
                    .secondary_lengths
                    .as_ref()
                    .map(|v| v.len())
                    .unwrap_or(n_cyl.min(2).max(1));
                set_or_init_array_element(
                    &mut cfg.secondary_lengths,
                    scalar,
                    n,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.secondary_length = value;
                if let Some(arr) = cfg.secondary_lengths.as_mut() {
                    for v in arr.iter_mut() {
                        *v = value;
                    }
                }
            }
        }
        "secondary_diameter_in" => {
            if let Some(i) = index {
                let scalar = cfg.secondary_diameter_in;
                let n = cfg
                    .secondary_diameters_in
                    .as_ref()
                    .map(|v| v.len())
                    .unwrap_or(n_cyl.min(2).max(1));
                set_or_init_array_element(
                    &mut cfg.secondary_diameters_in,
                    scalar,
                    n,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.secondary_diameter_in = value;
                if let Some(arr) = cfg.secondary_diameters_in.as_mut() {
                    for v in arr.iter_mut() {
                        *v = value;
                    }
                }
            }
        }
        "secondary_diameter_out" => {
            if let Some(i) = index {
                let scalar = cfg.secondary_diameter_out.unwrap_or(cfg.secondary_diameter_in);
                let n = cfg
                    .secondary_diameters_out
                    .as_ref()
                    .map(|v| v.len())
                    .unwrap_or(n_cyl.min(2).max(1));
                set_or_init_array_element_optopt(
                    &mut cfg.secondary_diameters_out,
                    scalar,
                    n,
                    i,
                    value,
                    path,
                )?;
            } else {
                cfg.secondary_diameter_out = Some(value);
                if let Some(arr) = cfg.secondary_diameters_out.as_mut() {
                    for v in arr.iter_mut() {
                        *v = Some(value);
                    }
                }
            }
        }
        "secondary_n_cells" => cfg.secondary_n_cells = to_usize(value),
        "secondary_wall_t" => {
            cfg.secondary_wall_t = value;
            if let Some(arr) = cfg.secondary_wall_ts.as_mut() {
                for v in arr.iter_mut() {
                    *v = value;
                }
            }
        }

        // Collector
        "collector_length" => cfg.collector_length = value,
        "collector_diameter_in" => cfg.collector_diameter_in = value,
        "collector_diameter_out" => cfg.collector_diameter_out = Some(value),
        "collector_n_cells" => cfg.collector_n_cells = to_usize(value),
        "collector_wall_t" => cfg.collector_wall_t = value,

        // Ambient
        "p_ambient" => cfg.p_ambient = value,
        "t_ambient" => cfg.t_ambient = value,

        // Combustion
        "wiebe_a" => cfg.wiebe_a = value,
        "wiebe_m" => cfg.wiebe_m = value,
        "combustion_duration" => cfg.combustion_duration = value,
        "spark_advance" => cfg.spark_advance = value,
        "ignition_delay" => cfg.ignition_delay = value,
        "eta_comb" => cfg.eta_comb = value,
        "q_lhv" => cfg.q_lhv = value,
        "afr_target" => cfg.afr_target = value,
        "t_wall_cylinder" => cfg.t_wall_cylinder = value,
        "woschni_c1_gas_exchange" => cfg.woschni_c1_gas_exchange = value,
        "woschni_c1_compression" => cfg.woschni_c1_compression = value,
        "woschni_c1_combustion" => cfg.woschni_c1_combustion = value,
        "woschni_c2_combustion" => cfg.woschni_c2_combustion = value,

        // Friction (Chen-Flynn FMEP) — see physics_findings/0002.
        "fmep_a" => cfg.fmep_a = value,
        "fmep_b" => cfg.fmep_b = value,
        "fmep_c" => cfg.fmep_c = value,

        // Valves
        "intake_valve_diameter" => cfg.intake_valve_diameter = value,
        "intake_valve_max_lift" => cfg.intake_valve_max_lift = value,
        "intake_valve_open_angle" => cfg.intake_valve_open_angle = value,
        "intake_valve_close_angle" => cfg.intake_valve_close_angle = value,
        "intake_valve_seat_angle" => cfg.intake_valve_seat_angle = value,
        "exhaust_valve_diameter" => cfg.exhaust_valve_diameter = value,
        "exhaust_valve_max_lift" => cfg.exhaust_valve_max_lift = value,
        "exhaust_valve_open_angle" => cfg.exhaust_valve_open_angle = value,
        "exhaust_valve_close_angle" => cfg.exhaust_valve_close_angle = value,
        "exhaust_valve_seat_angle" => cfg.exhaust_valve_seat_angle = value,

        // Drivetrain
        "drivetrain_efficiency" => cfg.drivetrain_efficiency = value,

        // Numerics
        "cfl" => cfg.cfl = value,

        _ => return Err(ParameterError::UnknownPath(path.to_string())),
    }
    Ok(())
}

// ---------------- Tests ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sdm26_path() -> Option<PathBuf> {
        // Prefer the bundled-resources copy; fall back to engine-sim's
        // python_ref configs which are vendored in-repo.
        let candidates = [
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
            "../engine-sim/python_ref/configs/sdm26.json",
        ];
        for c in candidates {
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(c);
            if p.exists() {
                return Some(p);
            }
        }
        None
    }

    fn load_cfg() -> SDM26Config {
        if let Some(p) = sdm26_path() {
            match engine_sim::config::loader::load_v1_json(&p) {
                Ok(c) => return c,
                Err(e) => panic!("failed to load sdm26 config at {}: {}", p.display(), e),
            }
        }
        // Fallback to the Default so tests still validate the wiring even
        // when the example file moves; this is honest because all paths
        // we exercise are present on Default.
        SDM26Config::default()
    }

    #[test]
    fn schema_covers_all_groups() {
        let cfg = load_cfg();
        let s = enumerate_schema(&cfg);
        for g in [
            "Geometry",
            "Intake",
            "Restrictor",
            "Exhaust",
            "Ambient",
            "Combustion",
            "Friction",
            "Valves",
            "Drivetrain",
            "Numerics",
        ] {
            assert!(s.iter().any(|m| m.group == g), "missing group {}", g);
        }
    }

    #[test]
    fn schema_paths_are_unique() {
        let cfg = load_cfg();
        let s = enumerate_schema(&cfg);
        let mut paths: Vec<_> = s.iter().map(|m| m.path.clone()).collect();
        paths.sort();
        let original_len = paths.len();
        paths.dedup();
        assert_eq!(paths.len(), original_len, "duplicate paths in schema");
    }

    #[test]
    fn schema_is_non_empty() {
        let cfg = load_cfg();
        let s = enumerate_schema(&cfg);
        assert!(s.len() >= 30, "expected ~50 params, got {}", s.len());
    }

    #[test]
    fn override_scalar_path() {
        let mut cfg = load_cfg();
        apply_override(&mut cfg, "restrictor_cd", 0.88).unwrap();
        assert!((cfg.restrictor_cd - 0.88).abs() < 1e-12);
    }

    #[test]
    fn override_uniform_array_writes_scalar_and_broadcasts() {
        let mut cfg = load_cfg();
        // Start with no per-cylinder override array.
        cfg.runner_lengths = Some(vec![0.10, 0.11, 0.12, 0.13]);
        apply_override(&mut cfg, "runner_length", 0.250).unwrap();
        assert!((cfg.runner_length - 0.250).abs() < 1e-12);
        for v in cfg.runner_lengths.as_ref().unwrap() {
            assert!((v - 0.250).abs() < 1e-12);
        }
    }

    #[test]
    fn override_uniform_array_when_none_just_writes_scalar() {
        let mut cfg = load_cfg();
        cfg.runner_lengths = None;
        apply_override(&mut cfg, "runner_length", 0.222).unwrap();
        assert!((cfg.runner_length - 0.222).abs() < 1e-12);
        assert!(cfg.runner_lengths.is_none(), "uniform write should not materialize array");
    }

    #[test]
    fn override_per_element_only_touches_index_and_materializes() {
        let mut cfg = load_cfg();
        cfg.runner_length = 0.245;
        cfg.runner_lengths = None;
        cfg.n_cylinders = 4;
        apply_override(&mut cfg, "runner_length[2]", 0.333).unwrap();
        let arr = cfg.runner_lengths.as_ref().expect("array materialized");
        assert_eq!(arr.len(), 4);
        assert!((arr[0] - 0.245).abs() < 1e-12);
        assert!((arr[1] - 0.245).abs() < 1e-12);
        assert!((arr[2] - 0.333).abs() < 1e-12);
        assert!((arr[3] - 0.245).abs() < 1e-12);
    }

    #[test]
    fn override_unknown_path_errors() {
        let mut cfg = load_cfg();
        let err = apply_override(&mut cfg, "not.a.field", 1.0).unwrap_err();
        assert!(matches!(err, ParameterError::UnknownPath(_)));
    }

    #[test]
    fn override_oob_index_errors() {
        let mut cfg = load_cfg();
        cfg.n_cylinders = 4;
        cfg.runner_lengths = Some(vec![0.2; 4]);
        let err = apply_override(&mut cfg, "runner_length[99]", 0.2).unwrap_err();
        assert!(matches!(err, ParameterError::IndexOutOfBounds { .. }));
    }

    #[test]
    fn override_integer_field_rounds() {
        let mut cfg = load_cfg();
        apply_override(&mut cfg, "runner_n_cells", 42.7).unwrap();
        assert_eq!(cfg.runner_n_cells, 43);
        apply_override(&mut cfg, "runner_n_cells", 42.4).unwrap();
        assert_eq!(cfg.runner_n_cells, 42);
    }

    /// Finding 0002 — Chen-Flynn FMEP coefficient sweep wiring.
    ///
    /// Verifies:
    ///   (1) `fmep_a`, `fmep_b`, `fmep_c` are accepted by `apply_override`.
    ///   (2) Each writes to the matching SDM26Config field exactly.
    ///   (3) The compiled defaults are still (0.5, 0.1, 0.003) — i.e., this
    ///       extension is wiring-only, parity must hold.
    #[test]
    fn override_chen_flynn_fmep_coefficients() {
        // Use Default (not loaded JSON) so this test is locked to the
        // physics defaults rather than whatever the example file says.
        let mut cfg = SDM26Config::default();

        // (3) Default parity check — assert before we mutate anything.
        assert!((cfg.fmep_a - 0.5).abs() < 1e-15, "default fmep_a drifted");
        assert!((cfg.fmep_b - 0.1).abs() < 1e-15, "default fmep_b drifted");
        assert!((cfg.fmep_c - 0.003).abs() < 1e-15, "default fmep_c drifted");

        // (1)+(2) Sweep each coefficient across a representative range from
        // study.toml (Heywood-typical low end up through the current default
        // and slightly beyond).
        for &v in &[0.04_f64, 0.05, 0.06, 0.075, 0.1, 0.12] {
            apply_override(&mut cfg, "fmep_b", v).unwrap();
            assert!(
                (cfg.fmep_b - v).abs() < 1e-15,
                "fmep_b override failed: expected {v}, got {}",
                cfg.fmep_b
            );
        }

        apply_override(&mut cfg, "fmep_a", 0.4).unwrap();
        assert!((cfg.fmep_a - 0.4).abs() < 1e-15);

        apply_override(&mut cfg, "fmep_c", 0.002).unwrap();
        assert!((cfg.fmep_c - 0.002).abs() < 1e-15);

        // Restore defaults via override (round-trip).
        apply_override(&mut cfg, "fmep_a", 0.5).unwrap();
        apply_override(&mut cfg, "fmep_b", 0.1).unwrap();
        apply_override(&mut cfg, "fmep_c", 0.003).unwrap();
        assert!((cfg.fmep_a - 0.5).abs() < 1e-15);
        assert!((cfg.fmep_b - 0.1).abs() < 1e-15);
        assert!((cfg.fmep_c - 0.003).abs() < 1e-15);
    }

    /// FMEP coefficients are present in the optimization schema (Friction
    /// group) so the UI / sweep tooling can discover them.
    #[test]
    fn schema_exposes_fmep_coefficients() {
        let cfg = load_cfg();
        let s = enumerate_schema(&cfg);
        for name in ["fmep_a", "fmep_b", "fmep_c"] {
            let meta = s
                .iter()
                .find(|m| m.path == name)
                .unwrap_or_else(|| panic!("schema missing {name}"));
            assert_eq!(meta.group, "Friction", "{name} not in Friction group");
            assert_eq!(meta.kind, ParameterType::Scalar);
        }
    }
}
