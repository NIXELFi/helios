//! V1-compatible JSON config loader. Direct port of `configs/config_loader.py`.

use std::fs;
use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::model::sdm26::{bellmouth_entry_k, profile_volume, ExhaustTopology, SDM26Config};

#[derive(Debug, Error)]
pub enum ConfigLoadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("schema: {0}")]
    Schema(String),
}

fn req_f64(v: &Value, key: &str) -> Result<f64, ConfigLoadError> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .ok_or_else(|| ConfigLoadError::Schema(format!("missing or non-numeric {key:?}")))
}

fn req_u(v: &Value, key: &str) -> Result<usize, ConfigLoadError> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|x| x as usize)
        .ok_or_else(|| ConfigLoadError::Schema(format!("missing or non-integer {key:?}")))
}

fn opt_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn unpack_cd_table(v: &Value, key: &str) -> Result<(Vec<f64>, Vec<f64>), ConfigLoadError> {
    let arr = v.get(key).and_then(|x| x.as_array()).ok_or_else(|| {
        ConfigLoadError::Schema(format!("missing array {key:?}"))
    })?;
    // An empty Cd table would make `valve_cd` index `[0]` out of bounds at
    // solve time. Reject it here with a schema error rather than panicking
    // mid-run.
    if arr.is_empty() {
        return Err(ConfigLoadError::Schema(format!("{key} must have at least one [L/D, Cd] row")));
    }
    let mut ld = Vec::with_capacity(arr.len());
    let mut cd = Vec::with_capacity(arr.len());
    for row in arr {
        let r = row.as_array().ok_or_else(|| {
            ConfigLoadError::Schema(format!("{key} row must be a 2-array"))
        })?;
        // Guard the [0]/[1] indexing — a short row (e.g. `[0.1]`) would
        // otherwise panic.
        if r.len() < 2 {
            return Err(ConfigLoadError::Schema(format!("{key} row must be a [L/D, Cd] pair")));
        }
        ld.push(r[0].as_f64().ok_or_else(|| ConfigLoadError::Schema("cd_table L/D".into()))?);
        cd.push(r[1].as_f64().ok_or_else(|| ConfigLoadError::Schema("cd_table Cd".into()))?);
    }
    Ok((ld, cd))
}

/// Required f64 field on every element of a pipe array. Returns a schema
/// error (never panics) when a pipe is missing the field or it is
/// non-numeric. `what` names the pipe group for the error message.
fn pipe_field(pipes: &[Value], key: &str, what: &str) -> Result<Vec<f64>, ConfigLoadError> {
    pipes
        .iter()
        .enumerate()
        .map(|(i, p)| {
            p.get(key)
                .and_then(|x| x.as_f64())
                .ok_or_else(|| ConfigLoadError::Schema(format!(
                    "{what}[{i}] missing or non-numeric {key:?}"
                )))
        })
        .collect()
}

/// Optional `[[rpm, value], ...]` map under `key` (findings 0030 / 0034).
/// Rows must be numeric pairs sorted by strictly increasing rpm. Absent or
/// empty -> Ok(None).
fn opt_rpm_map(v: &Value, key: &str, unit: &str) -> Result<Option<Vec<(f64, f64)>>, ConfigLoadError> {
    let Some(arr) = v.get(key).and_then(|x| x.as_array()) else { return Ok(None) };
    let pair = || ConfigLoadError::Schema(format!("{key} rows must be [rpm, {unit}] pairs"));
    let mut map: Vec<(f64, f64)> = Vec::with_capacity(arr.len());
    for row in arr {
        let r = row.as_array().ok_or_else(pair)?;
        if r.len() != 2 { return Err(pair()); }
        let rpm = r[0].as_f64().ok_or_else(|| ConfigLoadError::Schema(
            format!("{key} rpm must be numeric")))?;
        let y = r[1].as_f64().ok_or_else(|| ConfigLoadError::Schema(
            format!("{key} {unit} must be numeric")))?;
        map.push((rpm, y));
    }
    if map.windows(2).any(|w| w[1].0 <= w[0].0) {
        return Err(ConfigLoadError::Schema(
            format!("{key} must be sorted by strictly increasing rpm")));
    }
    Ok(if map.is_empty() { None } else { Some(map) })
}

/// Finding 0033: optional piecewise-linear diameter profile
/// `[[x, d], ...]` (m). Needs >= 2 rows, x[0] = 0, strictly increasing x,
/// positive d. Absent key -> Ok(None).
fn opt_profile(v: &Value, what: &str) -> Result<Option<Vec<(f64, f64)>>, ConfigLoadError> {
    let Some(raw) = v.get("diameter_profile") else { return Ok(None) };
    let err = |m: &str| ConfigLoadError::Schema(format!("{what}.diameter_profile {m}"));
    let arr = raw.as_array().ok_or_else(|| err("must be an array of [x, d] pairs"))?;
    let mut out = Vec::with_capacity(arr.len());
    for row in arr {
        let r = row.as_array().filter(|r| r.len() == 2)
            .ok_or_else(|| err("rows must be [x, d] pairs"))?;
        let x = r[0].as_f64().ok_or_else(|| err("x must be numeric"))?;
        let d = r[1].as_f64().ok_or_else(|| err("d must be numeric"))?;
        if !(d > 0.0) { return Err(err("diameters must be > 0")); }
        out.push((x, d));
    }
    if out.len() < 2 { return Err(err("needs at least 2 rows")); }
    if out[0].0.abs() > 1e-12 { return Err(err("must start at x = 0")); }
    if out.windows(2).any(|w| w[1].0 <= w[0].0) {
        return Err(err("x must be strictly increasing"));
    }
    Ok(Some(out))
}

/// Finding 0035: optional lumped minor losses `[[x, K], ...]` (x in m from
/// the pipe's upstream end, 0 <= x <= length; K >= 0). Absent key -> empty.
fn opt_local_losses(v: &Value, what: &str) -> Result<Vec<(f64, f64)>, ConfigLoadError> {
    let Some(raw) = v.get("local_losses") else { return Ok(Vec::new()) };
    let err = |m: &str| ConfigLoadError::Schema(format!("{what}.local_losses {m}"));
    let arr = raw.as_array().ok_or_else(|| err("must be an array of [x, K] pairs"))?;
    let l = opt_f64(v, "length").unwrap_or(f64::INFINITY);
    let mut out = Vec::with_capacity(arr.len());
    for row in arr {
        let r = row.as_array().filter(|r| r.len() == 2)
            .ok_or_else(|| err("rows must be [x, K] pairs"))?;
        let x = r[0].as_f64().ok_or_else(|| err("x must be numeric"))?;
        let k = r[1].as_f64().ok_or_else(|| err("K must be numeric"))?;
        if !k.is_finite() || k < 0.0 { return Err(err("K must be >= 0")); }
        if !(0.0..=l + 1e-9).contains(&x) { return Err(err("x must lie within the pipe length")); }
        out.push((x, k));
    }
    Ok(out)
}

fn all_same(values: &[f64]) -> bool {
    if values.is_empty() { return true; }
    values.iter().all(|v| (v - values[0]).abs() < 1e-12)
}

/// `all_same` for the optional `diameter_out` vectors: a pipe group is
/// uniform only when every entry is present-and-equal or every entry is
/// absent (both cases collapse to the scalar config field).
fn all_same_opt(values: &[Option<f64>]) -> bool {
    if values.is_empty() { return true; }
    values.iter().all(|v| match (v, values[0]) {
        (Some(a), Some(b)) => (a - b).abs() < 1e-12,
        (None, None) => true,
        _ => false,
    })
}

// ---- Schema key registry (finding 0032 fix 8) ------------------------------
//
// Keys the V1 schema defines per section. Anything else is reported as a
// load WARNING (typo / stale key) instead of being silently dropped: a
// misspelled physics flag used to leave the model on legacy physics with no
// trace. Some keys are accepted but not consumed by the 1-D solver
// (`simulation.*`, `roughness`, `artificial_viscosity`, `*_note`,
// `converging_half_angle`, `initial_*`); they are listed so they do not warn.

const TOP_KEYS: &[&str] = &[
    "name", "description", "n_cylinders", "firing_order", "firing_interval",
    "cylinder", "intake_valve", "exhaust_valve", "intake_pipes",
    "exhaust_primaries", "exhaust_secondaries", "exhaust_collector",
    "combustion", "restrictor", "plenum", "simulation", "p_ambient",
    "T_ambient", "drivetrain_efficiency", "physics",
];
const CYLINDER_KEYS: &[&str] = &[
    "bore", "stroke", "con_rod_length", "compression_ratio",
    "n_intake_valves", "n_exhaust_valves",
];
const VALVE_KEYS: &[&str] = &[
    "diameter", "max_lift", "open_angle", "close_angle", "seat_angle", "cd_table",
];
const PIPE_KEYS: &[&str] = &[
    "name", "length", "diameter", "diameter_out", "n_points",
    "wall_temperature", "roughness", "artificial_viscosity", "length_note",
];
/// Extra per-runner keys (finding 0032 fixes 1 + 4).
const RUNNER_EXTRA_KEYS: &[&str] = &[
    "entry_loss_k", "bellmouth_radius", "end_correction",
    // finding 0033
    "diameter_profile",
    // finding 0035
    "local_losses",
];
/// Extra keys on exhaust pipes (findings 0034, 0035).
const EXHAUST_EXTRA_KEYS: &[&str] = &["diameter_profile", "local_losses"];
const COMBUSTION_KEYS: &[&str] = &[
    "wiebe_a", "wiebe_m", "combustion_duration", "spark_advance",
    "ignition_delay", "combustion_efficiency", "q_lhv", "afr_stoich", "afr_target",
];
const RESTRICTOR_KEYS: &[&str] = &[
    "throat_diameter", "discharge_coefficient", "converging_half_angle",
    "diverging_half_angle", "outlet_diameter",
];
const PLENUM_KEYS: &[&str] = &[
    "volume", "length", "n_cells", "n_points", "wall_temperature",
    "initial_pressure", "initial_temperature", "diameter_profile",
];
const SIMULATION_KEYS: &[&str] = &[
    "rpm_start", "rpm_end", "rpm_step", "n_cycles", "cfl_number",
    "convergence_tolerance", "crank_step_max", "artificial_viscosity",
];

/// Numeric `physics` keys -> SDM26Config field setter. Returns false for
/// keys it does not own.
fn set_physics_f64(cfg: &mut SDM26Config, key: &str, v: f64) -> bool {
    match key {
        "spark_advance_rpm_slope_deg_per_krpm" => cfg.spark_advance_rpm_slope_deg_per_krpm = v,
        "spark_advance_rpm_ref" => cfg.spark_advance_rpm_ref = v,
        "duration_rpm_exp" => cfg.duration_rpm_exp = v,
        "duration_rpm_ref" => cfg.duration_rpm_ref = v,
        "wiebe_a_rpm_exp" => cfg.wiebe_a_rpm_exp = v,
        "wiebe_a_rpm_ref" => cfg.wiebe_a_rpm_ref = v,
        "tumble_burn_factor" => cfg.tumble_burn_factor = v,
        "restrictor_cd_mach_k" => cfg.restrictor_cd_mach_k = v,
        "restrictor_loss_coef" => cfg.restrictor_loss_coef = v,
        "restrictor_diffuser_efficiency" => cfg.restrictor_diffuser_efficiency = Some(v),
        "intake_junction_loss_coef" => cfg.intake_junction_loss_coef = v,
        "exhaust_junction_loss_coef" => cfg.exhaust_junction_loss_coef = v,
        "intake_runner_entry_k" => cfg.intake_runner_entry_k = v,
        "fmep_a" => cfg.fmep_a = v,
        "fmep_b" => cfg.fmep_b = v,
        "fmep_c" => cfg.fmep_c = v,
        "cfl" => cfg.cfl = v,
        "intake_lift_flat_top_ramp" => cfg.intake_lift_flat_top_ramp = v,
        "exhaust_lift_flat_top_ramp" => cfg.exhaust_lift_flat_top_ramp = v,
        "intake_valve_re_cd_min" => cfg.intake_valve_re_cd_min = v,
        "intake_valve_re_crit" => cfg.intake_valve_re_crit = v,
        "exhaust_collector_reflection_coef" => cfg.exhaust_collector_reflection_coef = v,
        "exhaust_merge_angle_deg" => cfg.exhaust_merge_angle_deg = v,
        "exhaust_gas_gamma" => cfg.exhaust_gas_gamma = v,
        "exhaust_gas_r" => cfg.exhaust_gas_r = v,
        "knock_integral_limit" => cfg.knock_integral_limit = v,
        "knock_retard_step_deg" => cfg.knock_retard_step_deg = v,
        "knock_max_retard_deg" => cfg.knock_max_retard_deg = v,
        "knock_tau_scale" => cfg.knock_tau_scale = v,
        "octane_number" => cfg.octane_number = v,
        "valve_event_reference_lift" => cfg.valve_event_reference_lift = v,
        "valve_lift_shape_exponent" => cfg.valve_lift_shape_exponent = v,
        _ => return false,
    }
    true
}

/// Boolean `physics` keys -> SDM26Config field setter.
fn set_physics_bool(cfg: &mut SDM26Config, key: &str, v: bool) -> bool {
    match key {
        "restrictor_loss_from_diffuser_geometry" => cfg.restrictor_loss_from_diffuser_geometry = v,
        "restrictor_venturi_model" => cfg.restrictor_venturi_model = v,
        "intake_junction_borda_carnot" => cfg.intake_junction_borda_carnot = v,
        "intake_junction_directional_loss" => cfg.intake_junction_directional_loss = v,
        "exhaust_junction_borda_carnot" => cfg.exhaust_junction_borda_carnot = v,
        "exhaust_junction_momentum" => cfg.exhaust_junction_momentum = v,
        "intake_valve_re_correction_enabled" => cfg.intake_valve_re_correction_enabled = v,
        "afr_eta_enabled" => cfg.afr_eta_enabled = v,
        "knock_control_enabled" => cfg.knock_control_enabled = v,
        "two_zone_enabled" => cfg.two_zone_enabled = v,
        "two_zone_gamma_cv_weighted" => cfg.two_zone_gamma_cv_weighted = v,
        "use_weno5_in_pipes" => cfg.use_weno5_in_pipes = v,
        "enable_residual_tracking" => cfg.enable_residual_tracking = v,
        "intake_runner_end_correction" => cfg.intake_runner_end_correction = v,
        "exhaust_collector_end_correction" => cfg.exhaust_collector_end_correction = v,
        "exhaust_collector_open_end_physical" => cfg.exhaust_collector_open_end_physical = v,
        "fuel_mass_from_trapped_air" => cfg.fuel_mass_from_trapped_air = v,
        "heat_release_o2_limited" => cfg.heat_release_o2_limited = v,
        "valve_events_at_reference_lift" => cfg.valve_events_at_reference_lift = v,
        _ => return false,
    }
    true
}

fn is_physics_f64_key(key: &str) -> bool {
    set_physics_f64(&mut SDM26Config::default(), key, 0.0)
}

fn is_physics_bool_key(key: &str) -> bool {
    set_physics_bool(&mut SDM26Config::default(), key, false)
}

/// Report keys of `obj` that are not in `known` (or `extra`) as warnings.
/// Keys starting with `_` are treated as comments and never warn.
fn warn_unknown(
    obj: &Value, section: &str, known: &[&str], extra: &[&str], warnings: &mut Vec<String>,
) {
    if let Some(map) = obj.as_object() {
        for k in map.keys() {
            if k.starts_with('_') || known.contains(&k.as_str()) || extra.contains(&k.as_str()) {
                continue;
            }
            let path = if section.is_empty() { k.clone() } else { format!("{section}.{k}") };
            warnings.push(format!(
                "unknown key {path} ignored (typo? not part of the V1 config schema)"
            ));
        }
    }
}

pub fn load_v1_json<P: AsRef<Path>>(path: P) -> Result<SDM26Config, ConfigLoadError> {
    load_v1_json_with_warnings(path).map(|(cfg, _)| cfg)
}

/// As [`load_v1_json`], also returning human-readable load warnings:
/// unknown / misspelled keys, `physics` keys with the wrong JSON type, and
/// defaulted fields worth knowing about. Warnings never change the loaded
/// config; callers surface them in logs / the UI.
pub fn load_v1_json_with_warnings<P: AsRef<Path>>(
    path: P,
) -> Result<(SDM26Config, Vec<String>), ConfigLoadError> {
    let text = fs::read_to_string(path)?;
    let data: Value = serde_json::from_str(&text)?;
    load_v1_value(&data)
}

/// Parse an already-decoded V1 JSON document (see `load_v1_json_with_warnings`).
pub fn load_v1_value(data: &Value) -> Result<(SDM26Config, Vec<String>), ConfigLoadError> {
    let data = data.clone();
    let mut warnings: Vec<String> = Vec::new();

    let cyl = data.get("cylinder").ok_or_else(|| ConfigLoadError::Schema("cylinder".into()))?;
    let iv = data.get("intake_valve").ok_or_else(|| ConfigLoadError::Schema("intake_valve".into()))?;
    let ev = data.get("exhaust_valve").ok_or_else(|| ConfigLoadError::Schema("exhaust_valve".into()))?;
    let runners = data.get("intake_pipes").and_then(|x| x.as_array())
        .ok_or_else(|| ConfigLoadError::Schema("intake_pipes".into()))?;
    let primaries = data.get("exhaust_primaries").and_then(|x| x.as_array())
        .ok_or_else(|| ConfigLoadError::Schema("exhaust_primaries".into()))?;
    let secondaries: Vec<Value> = data.get("exhaust_secondaries")
        .and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let collector = data.get("exhaust_collector").ok_or_else(|| ConfigLoadError::Schema("exhaust_collector".into()))?;
    let comb = data.get("combustion").ok_or_else(|| ConfigLoadError::Schema("combustion".into()))?;
    let restr = data.get("restrictor").ok_or_else(|| ConfigLoadError::Schema("restrictor".into()))?;
    let plen = data.get("plenum").ok_or_else(|| ConfigLoadError::Schema("plenum".into()))?;

    let topology = if secondaries.len() == 2 {
        ExhaustTopology::FourTwoOne
    } else {
        ExhaustTopology::FourOne
    };

    let (intake_ld, intake_cd) = unpack_cd_table(iv, "cd_table")?;
    let (exhaust_ld, exhaust_cd) = unpack_cd_table(ev, "cd_table")?;

    // `intake_pipes` / `exhaust_primaries` must be non-empty: we index
    // `[0]` below to seed the scalar config fields. Reject empty here with
    // a schema error rather than panicking on the index.
    if runners.is_empty() {
        return Err(ConfigLoadError::Schema("intake_pipes must have at least one pipe".into()));
    }
    if primaries.is_empty() {
        return Err(ConfigLoadError::Schema("exhaust_primaries must have at least one pipe".into()));
    }

    // One runner and one primary PER CYLINDER: `SDM26Engine::new` builds
    // `0..n_cylinders` of each and indexes the per-pipe vectors unguarded, so
    // a short array panics inside the solver thread and a long one silently
    // drops the extra pipes. Reject the mismatch here instead.
    //
    // Secondaries are deliberately NOT checked against `n_cylinders`: a 4-2-1
    // header has exactly 2 by design, and that count is what selects
    // `ExhaustTopology::FourTwoOne` above — any other count means 4-1, where
    // no secondary is built and `secondary_spec` is never called.
    let n_cyl = req_u(&data, "n_cylinders")?;
    if runners.len() != n_cyl {
        return Err(ConfigLoadError::Schema(format!(
            "intake_pipes has {} entries but n_cylinders is {n_cyl}; one runner per cylinder is required",
            runners.len()
        )));
    }
    if primaries.len() != n_cyl {
        return Err(ConfigLoadError::Schema(format!(
            "exhaust_primaries has {} entries but n_cylinders is {n_cyl}; one primary per cylinder is required",
            primaries.len()
        )));
    }

    let runner_lengths: Vec<f64> = pipe_field(runners, "length", "intake_pipes")?;
    let runner_diameters_in: Vec<f64> = pipe_field(runners, "diameter", "intake_pipes")?;
    let runner_diameters_out: Vec<Option<f64>> = runners.iter()
        .map(|p| p.get("diameter_out").and_then(|x| x.as_f64()))
        .collect();
    let runner_wall_ts: Vec<f64> = pipe_field(runners, "wall_temperature", "intake_pipes")?;

    let primary_lengths: Vec<f64> = pipe_field(primaries, "length", "exhaust_primaries")?;
    let primary_diameters_in: Vec<f64> = pipe_field(primaries, "diameter", "exhaust_primaries")?;
    let primary_diameters_out: Vec<Option<f64>> = primaries.iter()
        .map(|p| p.get("diameter_out").and_then(|x| x.as_f64())).collect();
    let primary_wall_ts: Vec<f64> = pipe_field(primaries, "wall_temperature", "exhaust_primaries")?;

    let secondary_lengths: Vec<f64> = pipe_field(&secondaries, "length", "exhaust_secondaries")?;
    let secondary_diameters_in: Vec<f64> = pipe_field(&secondaries, "diameter", "exhaust_secondaries")?;
    let secondary_diameters_out: Vec<Option<f64>> = secondaries.iter()
        .map(|p| p.get("diameter_out").and_then(|x| x.as_f64())).collect();
    let secondary_wall_ts: Vec<f64> = pipe_field(&secondaries, "wall_temperature", "exhaust_secondaries")?;

    let mut cfg = SDM26Config::default();
    cfg.bore = req_f64(cyl, "bore")?;
    cfg.stroke = req_f64(cyl, "stroke")?;
    cfg.con_rod = req_f64(cyl, "con_rod_length")?;
    cfg.cr = req_f64(cyl, "compression_ratio")?;
    cfg.n_cylinders = n_cyl;
    let firing_order = data.get("firing_order").and_then(|x| x.as_array())
        .ok_or_else(|| ConfigLoadError::Schema("missing array \"firing_order\"".into()))?;
    cfg.firing_order = firing_order.iter().enumerate()
        .map(|(i, v)| {
            v.as_i64()
                .map(|n| n as i32)
                .ok_or_else(|| ConfigLoadError::Schema(format!(
                    "firing_order[{i}] must be an integer"
                )))
        })
        .collect::<Result<Vec<i32>, _>>()?;
    cfg.firing_interval = req_f64(&data, "firing_interval")?;

    cfg.runner_length = runner_lengths[0];
    cfg.runner_diameter_in = runner_diameters_in[0];
    cfg.runner_diameter_out = runner_diameters_out[0];
    cfg.runner_n_cells = req_u(&runners[0], "n_points")?;
    cfg.runner_wall_t = runner_wall_ts[0];

    cfg.primary_length = primary_lengths[0];
    cfg.primary_diameter_in = primary_diameters_in[0];
    cfg.primary_diameter_out = primary_diameters_out[0];
    cfg.primary_n_cells = req_u(&primaries[0], "n_points")?;
    cfg.primary_wall_t = primary_wall_ts[0];

    cfg.collector_length = req_f64(collector, "length")?;
    cfg.collector_diameter_in = req_f64(collector, "diameter")?;
    cfg.collector_diameter_out = collector.get("diameter_out").and_then(|x| x.as_f64());
    cfg.collector_n_cells = req_u(collector, "n_points")?;
    cfg.collector_wall_t = req_f64(collector, "wall_temperature")?;

    cfg.plenum_volume = req_f64(plen, "volume")?;
    // 0032 fix 3: plenum pipe length / resolution / wall T are config data
    // (were hard-wired 0.3 m / 20 cells / 320 K). Defaults unchanged.
    if let Some(l) = opt_f64(plen, "length") {
        if !(l > 0.0) {
            return Err(ConfigLoadError::Schema("plenum.length must be > 0".into()));
        }
        cfg.plenum_length = l;
    }
    if let Some(n) = plen.get("n_cells").or_else(|| plen.get("n_points")).and_then(|x| x.as_u64()) {
        if n < 4 {
            return Err(ConfigLoadError::Schema("plenum.n_cells must be >= 4".into()));
        }
        cfg.plenum_n_cells = n as usize;
    }
    if let Some(t) = opt_f64(plen, "wall_temperature") { cfg.plenum_wall_t = t; }
    // Finding 0033: shaped (e.g. bell) plenum. The profile defines the pipe:
    // its end x is the length and its integral the volume.
    if let Some(prof) = opt_profile(plen, "plenum")? {
        let l = prof[prof.len() - 1].0;
        let v = profile_volume(&prof);
        if (cfg.plenum_volume - v).abs() > 0.02 * v {
            warnings.push(format!(
                "plenum.volume {:.4} L disagrees with diameter_profile volume {:.4} L; using the profile",
                cfg.plenum_volume * 1e3, v * 1e3));
        }
        if let Some(lj) = opt_f64(plen, "length") {
            if (lj - l).abs() > 1e-4 {
                warnings.push(format!(
                    "plenum.length {lj} disagrees with diameter_profile end x {l}; using the profile"));
            }
        }
        cfg.plenum_volume = v;
        cfg.plenum_length = l;
        cfg.plenum_diameter_profile = Some(prof);
    }
    cfg.restrictor_throat_diameter = req_f64(restr, "throat_diameter")?;
    cfg.restrictor_cd = req_f64(restr, "discharge_coefficient")?;
    if let Some(d) = opt_f64(restr, "outlet_diameter") {
        if !(d > cfg.restrictor_throat_diameter) {
            return Err(ConfigLoadError::Schema(
                "restrictor.outlet_diameter must exceed throat_diameter".into()));
        }
        cfg.restrictor_outlet_diameter = Some(d);
    }
    // 0006: pick up the diffuser half-angle if present (was silently dropped).
    // Default 6.0 if not in JSON — preserves behavior for older configs
    // that omit the field, and provides a sensible value for SDM26.
    if let Some(angle) = restr.get("diverging_half_angle").and_then(|x| x.as_f64()) {
        cfg.restrictor_diverging_half_angle_deg = angle;
    }
    cfg.p_ambient = req_f64(&data, "p_ambient")?;
    cfg.t_ambient = req_f64(&data, "T_ambient")?;

    cfg.wiebe_a = req_f64(comb, "wiebe_a")?;
    cfg.wiebe_m = req_f64(comb, "wiebe_m")?;
    cfg.combustion_duration = req_f64(comb, "combustion_duration")?;
    cfg.spark_advance = req_f64(comb, "spark_advance")?;
    cfg.ignition_delay = req_f64(comb, "ignition_delay")?;
    cfg.eta_comb = req_f64(comb, "combustion_efficiency")?;
    cfg.q_lhv = req_f64(comb, "q_lhv")?;
    cfg.afr_target = req_f64(comb, "afr_target")?;
    // Optional — defaults to gasoline (14.7) so configs without it (and every
    // existing parity fixture) load unchanged.
    cfg.afr_stoich = comb.get("afr_stoich").and_then(|x| x.as_f64()).unwrap_or(14.7);

    cfg.intake_valve_diameter = req_f64(iv, "diameter")?;
    cfg.intake_valve_max_lift = req_f64(iv, "max_lift")?;
    cfg.intake_valve_open_angle = req_f64(iv, "open_angle")?;
    cfg.intake_valve_close_angle = req_f64(iv, "close_angle")?;
    cfg.intake_valve_seat_angle = req_f64(iv, "seat_angle")?;
    cfg.intake_n_valves = cyl.get("n_intake_valves")
        .and_then(|x| x.as_u64()).map(|x| x as usize).unwrap_or(2);
    cfg.intake_ld_table = intake_ld;
    cfg.intake_cd_table = intake_cd;

    cfg.exhaust_valve_diameter = req_f64(ev, "diameter")?;
    cfg.exhaust_valve_max_lift = req_f64(ev, "max_lift")?;
    cfg.exhaust_valve_open_angle = req_f64(ev, "open_angle")?;
    cfg.exhaust_valve_close_angle = req_f64(ev, "close_angle")?;
    cfg.exhaust_valve_seat_angle = req_f64(ev, "seat_angle")?;
    cfg.exhaust_n_valves = cyl.get("n_exhaust_valves")
        .and_then(|x| x.as_u64()).map(|x| x as usize).unwrap_or(2);
    cfg.exhaust_ld_table = exhaust_ld;
    cfg.exhaust_cd_table = exhaust_cd;

    cfg.exhaust_topology = topology;
    // Fallback matches the struct default (0.85, Python models/sdm26.py
    // "Fix 14b"). The loader used to fall back to 0.91: a silent 7 %
    // wheel-power disagreement between a config without the key and
    // `SDM26Config::default()`.
    cfg.drivetrain_efficiency = match opt_f64(&data, "drivetrain_efficiency") {
        Some(v) => v,
        None => {
            let d = SDM26Config::default().drivetrain_efficiency;
            warnings.push(format!("drivetrain_efficiency missing; using default {d}"));
            d
        }
    };

    // Per-pipe geometry: stored only when it actually varies, otherwise the
    // scalar seeded from `[0]` above already describes every pipe. Port gap
    // (0731): only lengths and inlet diameters were mirrored here, so a
    // stepped `diameter_out`, per-pipe `wall_temperature`, or a 4-2-1 with
    // unequal secondaries loaded without complaint and ran every pipe with
    // pipe #1's geometry.
    if !all_same(&runner_lengths) { cfg.runner_lengths = Some(runner_lengths); }
    if !all_same(&runner_diameters_in) { cfg.runner_diameters_in = Some(runner_diameters_in); }
    if !all_same_opt(&runner_diameters_out) { cfg.runner_diameters_out = Some(runner_diameters_out); }
    if !all_same(&runner_wall_ts) { cfg.runner_wall_ts = Some(runner_wall_ts); }
    if !all_same(&primary_lengths) { cfg.primary_lengths = Some(primary_lengths); }
    if !all_same(&primary_diameters_in) { cfg.primary_diameters_in = Some(primary_diameters_in); }
    if !all_same_opt(&primary_diameters_out) { cfg.primary_diameters_out = Some(primary_diameters_out); }
    if !all_same(&primary_wall_ts) { cfg.primary_wall_ts = Some(primary_wall_ts); }
    if topology == ExhaustTopology::FourTwoOne {
        cfg.secondary_length = secondary_lengths[0];
        cfg.secondary_diameter_in = secondary_diameters_in[0];
        cfg.secondary_diameter_out = secondary_diameters_out[0];
        cfg.secondary_n_cells = req_u(&secondaries[0], "n_points")?;
        cfg.secondary_wall_t = secondary_wall_ts[0];
        if !all_same(&secondary_lengths) { cfg.secondary_lengths = Some(secondary_lengths); }
        if !all_same(&secondary_diameters_in) { cfg.secondary_diameters_in = Some(secondary_diameters_in); }
        if !all_same_opt(&secondary_diameters_out) { cfg.secondary_diameters_out = Some(secondary_diameters_out); }
        if !all_same(&secondary_wall_ts) { cfg.secondary_wall_ts = Some(secondary_wall_ts); }
    }

    // ---- Optional `physics` section -------------------------------------
    // The dyno-validated physics refinements (findings 0005/0006/0020/0021)
    // live behind opt-in SDM26Config fields whose defaults preserve the
    // legacy Python behavior. Until now they were ONLY reachable through
    // sweep/optimization overrides (cfd-core apply_override) — a config file
    // could not turn them on, so the app always ran legacy physics. This
    // section makes them first-class config: every key is optional, and a
    // config without the section (including every parity fixture) loads
    // bit-identically to before.
    if let Some(phys) = data.get("physics") {
        match phys.as_object() {
            None => warnings.push("physics section is not an object; ignored".into()),
            Some(map) => {
                for (k, v) in map {
                    if k.starts_with('_') { continue; }
                    match k.as_str() {
                        // Finding 0028: numerics limiter enum.
                        "limiter" => match v.as_i64() {
                            Some(n) => cfg.limiter = n as i32,
                            None => warnings.push(format!(
                                "physics.limiter must be an integer; got {v} (ignored)")),
                        },
                        // Finding 0030: parsed (and validated) below.
                        "spark_advance_map" | "afr_map" => {}
                        key => {
                            let applied = match (v.as_bool(), v.as_f64()) {
                                (Some(b), _) => set_physics_bool(&mut cfg, key, b),
                                (None, Some(x)) => set_physics_f64(&mut cfg, key, x),
                                _ => false,
                            };
                            if !applied {
                                let why = if is_physics_bool_key(key) {
                                    format!("physics.{key} expects true/false; got {v} (ignored)")
                                } else if is_physics_f64_key(key) {
                                    format!("physics.{key} expects a number; got {v} (ignored)")
                                } else {
                                    format!("unknown key physics.{key} ignored (typo? not a known physics flag)")
                                };
                                warnings.push(why);
                            }
                        }
                    }
                }
            }
        }
        // Finding 0030: measured per-RPM ignition map, [[rpm, deg], ...].
        // Lets a config run the engine's actual ECU table instead of the
        // idealized scalar + slope tune.
        if let Some(map) = opt_rpm_map(phys, "spark_advance_map", "deg")? {
            cfg.spark_advance_map = Some(map);
        }
        // Finding 0034: measured per-RPM AFR map, [[rpm, afr], ...].
        if let Some(map) = opt_rpm_map(phys, "afr_map", "afr")? {
            if map.iter().any(|&(_, a)| !(a > 1.0)) {
                return Err(ConfigLoadError::Schema("afr_map afr must be > 1".into()));
            }
            cfg.afr_map = Some(map);
        }
        // Finding 0035: exhaust gas properties must be a real gas.
        if !(cfg.exhaust_gas_gamma > 1.1 && cfg.exhaust_gas_gamma <= 1.67) {
            return Err(ConfigLoadError::Schema(format!(
                "physics.exhaust_gas_gamma must be in (1.1, 1.67]; got {}", cfg.exhaust_gas_gamma)));
        }
        if !(cfg.exhaust_gas_r > 200.0 && cfg.exhaust_gas_r < 400.0) {
            return Err(ConfigLoadError::Schema(format!(
                "physics.exhaust_gas_r must be in (200, 400) J/kg/K; got {}", cfg.exhaust_gas_r)));
        }
    }

    // ---- Per-runner entry loss / end correction (finding 0032) ---------
    // `entry_loss_k` wins; otherwise a `bellmouth_radius` maps to K via
    // Crane TP-410; otherwise NaN = "use physics.intake_runner_entry_k".
    let entry_ks: Vec<f64> = runners.iter()
        .map(|p| {
            let d = opt_f64(p, "diameter").unwrap_or(1.0);
            if let Some(k) = opt_f64(p, "entry_loss_k") { return k; }
            if let Some(rb) = opt_f64(p, "bellmouth_radius") {
                return bellmouth_entry_k(rb / d.max(1e-9));
            }
            f64::NAN
        })
        .collect();
    if entry_ks.iter().any(|k| k.is_finite()) {
        cfg.intake_runner_entry_ks = Some(entry_ks);
    }
    let end_corrs: Vec<f64> = runners.iter()
        .map(|p| opt_f64(p, "end_correction").unwrap_or(f64::NAN))
        .collect();
    if end_corrs.iter().any(|k| k.is_finite()) {
        cfg.intake_runner_end_corrections = Some(end_corrs);
    }

    // ---- Per-runner diameter profile (finding 0033) ---------------------
    let mut profiles: Vec<Option<Vec<(f64, f64)>>> = Vec::with_capacity(runners.len());
    for (i, p) in runners.iter().enumerate() {
        let prof = opt_profile(p, &format!("intake_pipes[{i}]"))?;
        if let Some(pr) = prof.as_ref() {
            let l = opt_f64(p, "length").unwrap_or(0.0);
            let x_last = pr[pr.len() - 1].0;
            if (l - x_last).abs() > 1e-3 {
                warnings.push(format!(
                    "intake_pipes[{i}].diameter_profile ends at x = {x_last} but length is {l}; the profile is stretched to the length"));
            }
        }
        profiles.push(prof);
    }
    if profiles.iter().any(|p| p.is_some()) {
        cfg.runner_diameter_profiles = Some(profiles);
    }

    // ---- Exhaust diameter profiles (finding 0034) -----------------------
    // Same contract as the runner profile: x from the upstream end,
    // stretched to the pipe `length` (warned when they disagree).
    let mut exhaust_profiles = |pipes: &[Value], what: &str|
        -> Result<Option<Vec<Option<Vec<(f64, f64)>>>>, ConfigLoadError>
    {
        let mut out = Vec::with_capacity(pipes.len());
        for (i, p) in pipes.iter().enumerate() {
            let prof = opt_profile(p, &format!("{what}[{i}]"))?;
            if let Some(pr) = prof.as_ref() {
                let l = opt_f64(p, "length").unwrap_or(0.0);
                let x_last = pr[pr.len() - 1].0;
                if (l - x_last).abs() > 1e-3 {
                    warnings.push(format!(
                        "{what}[{i}].diameter_profile ends at x = {x_last} but length is {l}; the profile is stretched to the length"));
                }
            }
            out.push(prof);
        }
        Ok(if out.iter().any(|p| p.is_some()) { Some(out) } else { None })
    };
    cfg.primary_diameter_profiles = exhaust_profiles(primaries, "exhaust_primaries")?;
    if !secondaries.is_empty() {
        cfg.secondary_diameter_profiles = exhaust_profiles(&secondaries, "exhaust_secondaries")?;
    }
    cfg.collector_diameter_profile = exhaust_profiles(std::slice::from_ref(collector), "exhaust_collector")?
        .and_then(|mut v| v.pop().flatten());

    // ---- Lumped minor losses (finding 0035) ------------------------------
    type LossGroup = Option<Vec<Vec<(f64, f64)>>>;
    let group = |pipes: &[Value], what: &str| -> Result<LossGroup, ConfigLoadError> {
        let v = pipes.iter().enumerate()
            .map(|(i, p)| opt_local_losses(p, &format!("{what}[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(if v.iter().any(|l| !l.is_empty()) { Some(v) } else { None })
    };
    cfg.runner_local_losses = group(runners, "intake_pipes")?;
    cfg.primary_local_losses = group(primaries, "exhaust_primaries")?;
    if !secondaries.is_empty() {
        cfg.secondary_local_losses = group(&secondaries, "exhaust_secondaries")?;
    }
    let col = opt_local_losses(collector, "exhaust_collector")?;
    if !col.is_empty() { cfg.collector_local_losses = Some(col); }

    // ---- Unknown-key warnings (finding 0032 fix 8) ----------------------
    warn_unknown(&data, "", TOP_KEYS, &[], &mut warnings);
    warn_unknown(cyl, "cylinder", CYLINDER_KEYS, &[], &mut warnings);
    warn_unknown(iv, "intake_valve", VALVE_KEYS, &[], &mut warnings);
    warn_unknown(ev, "exhaust_valve", VALVE_KEYS, &[], &mut warnings);
    for (i, p) in runners.iter().enumerate() {
        warn_unknown(p, &format!("intake_pipes[{i}]"), PIPE_KEYS, RUNNER_EXTRA_KEYS, &mut warnings);
    }
    for (i, p) in primaries.iter().enumerate() {
        warn_unknown(p, &format!("exhaust_primaries[{i}]"), PIPE_KEYS, EXHAUST_EXTRA_KEYS, &mut warnings);
    }
    for (i, p) in secondaries.iter().enumerate() {
        warn_unknown(p, &format!("exhaust_secondaries[{i}]"), PIPE_KEYS, EXHAUST_EXTRA_KEYS, &mut warnings);
    }
    warn_unknown(collector, "exhaust_collector", PIPE_KEYS, EXHAUST_EXTRA_KEYS, &mut warnings);
    warn_unknown(comb, "combustion", COMBUSTION_KEYS, &[], &mut warnings);
    warn_unknown(restr, "restrictor", RESTRICTOR_KEYS, &[], &mut warnings);
    warn_unknown(plen, "plenum", PLENUM_KEYS, &[], &mut warnings);
    if let Some(sim) = data.get("simulation") {
        warn_unknown(sim, "simulation", SIMULATION_KEYS, &[], &mut warnings);
    }

    Ok((cfg, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn python_ref_sdm26() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python_ref/configs/sdm26.json")
    }

    fn write_temp(value: &Value) -> std::path::PathBuf {
        // Unique per call — tests run in parallel within one process, so a
        // pid-only name races (one test deletes while another reads).
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "loader-physics-test-{}-{}.json",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(serde_json::to_string(value).unwrap().as_bytes()).unwrap();
        p
    }

    #[test]
    fn config_without_physics_section_loads_with_legacy_defaults() {
        let cfg = load_v1_json(python_ref_sdm26()).unwrap();
        let def = SDM26Config::default();
        assert_eq!(cfg.spark_advance_rpm_slope_deg_per_krpm, def.spark_advance_rpm_slope_deg_per_krpm);
        assert_eq!(cfg.duration_rpm_exp, def.duration_rpm_exp);
        assert_eq!(cfg.restrictor_cd_mach_k, def.restrictor_cd_mach_k);
        assert_eq!(cfg.restrictor_loss_from_diffuser_geometry, def.restrictor_loss_from_diffuser_geometry);
        assert_eq!(cfg.intake_junction_borda_carnot, def.intake_junction_borda_carnot);
        assert_eq!(cfg.fmep_c, def.fmep_c);
    }

    #[test]
    fn spark_advance_map_loads_and_interpolates() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        data["physics"] = serde_json::json!({
            "spark_advance_map": [[6000.0, 20.0], [10000.0, 28.0]],
        });
        let p = write_temp(&data);
        let cfg = load_v1_json(&p).unwrap();
        let _ = fs::remove_file(&p);
        let map = cfg.spark_advance_map.as_ref().expect("map loaded");
        assert_eq!(map.len(), 2);
        // interp behavior is owned by WiebeParams::spark_advance_at
        let wiebe = crate::cylinder::combustion::WiebeParams {
            spark_map: cfg.spark_advance_map.clone(),
            ..Default::default()
        };
        assert_eq!(wiebe.spark_advance_at(5000.0), 20.0); // clamped low
        assert_eq!(wiebe.spark_advance_at(8000.0), 24.0); // midpoint
        assert_eq!(wiebe.spark_advance_at(12000.0), 28.0); // clamped high
    }

    #[test]
    fn unsorted_spark_advance_map_is_rejected() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        data["physics"] = serde_json::json!({
            "spark_advance_map": [[10000.0, 28.0], [6000.0, 20.0]],
        });
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(res.is_err());
    }

    #[test]
    fn empty_cd_table_is_rejected_not_panic() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        data["intake_valve"]["cd_table"] = serde_json::json!([]);
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        match res {
            Err(ConfigLoadError::Schema(_)) => {}
            other => panic!("expected Schema error for empty cd_table, got {other:?}"),
        }
    }

    #[test]
    fn short_cd_table_row_is_rejected_not_panic() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        // A row with only one element must be a schema error, not an
        // out-of-bounds index panic.
        data["exhaust_valve"]["cd_table"] = serde_json::json!([[0.1]]);
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(matches!(res, Err(ConfigLoadError::Schema(_))));
    }

    #[test]
    fn missing_pipe_field_is_schema_error_not_panic() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        // Drop a required numeric field from the first intake pipe. Old
        // code did `p["length"].as_f64().unwrap()` → panic.
        if let Some(arr) = data["intake_pipes"].as_array_mut() {
            if let Some(obj) = arr.get_mut(0).and_then(|v| v.as_object_mut()) {
                obj.remove("length");
            }
        }
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(matches!(res, Err(ConfigLoadError::Schema(_))));
    }

    #[test]
    fn empty_intake_pipes_is_schema_error_not_panic() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        // Empty array would otherwise panic on the `runners[0]` index.
        data["intake_pipes"] = serde_json::json!([]);
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(matches!(res, Err(ConfigLoadError::Schema(_))));
    }

    #[test]
    fn pipe_count_must_match_n_cylinders() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        // Two runners of DIFFERENT length on a 4-cylinder: `runner_spec(2)`
        // used to index out of bounds inside the solver thread.
        let mut data: Value = serde_json::from_str(&text).unwrap();
        let arr = data["intake_pipes"].as_array().unwrap();
        let mut two = vec![arr[0].clone(), arr[1].clone()];
        two[1]["length"] = serde_json::json!(0.3);
        data["intake_pipes"] = Value::Array(two);
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(matches!(res, Err(ConfigLoadError::Schema(_))));

        // Same for primaries, and an OVER-long array is rejected too (it
        // would silently drop the extra pipes).
        let mut data: Value = serde_json::from_str(&text).unwrap();
        let arr = data["exhaust_primaries"].as_array().unwrap().clone();
        let mut five = arr.clone();
        five.push(arr[0].clone());
        data["exhaust_primaries"] = Value::Array(five);
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(matches!(res, Err(ConfigLoadError::Schema(_))));
    }

    #[test]
    fn four_two_one_secondaries_are_not_constrained_to_n_cylinders() {
        // The shipped SDM26 is a 4-2-1: 4 cylinders, 2 secondaries. That is
        // legal and must still load.
        let cfg = load_v1_json(python_ref_sdm26()).unwrap();
        assert_eq!(cfg.n_cylinders, 4);
        assert_eq!(cfg.exhaust_topology, ExhaustTopology::FourTwoOne);
    }

    #[test]
    fn non_uniform_secondary_and_wall_geometry_reaches_the_config() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        data["exhaust_secondaries"][1]["length"] = serde_json::json!(0.5);
        data["exhaust_secondaries"][1]["diameter_out"] = serde_json::json!(0.042);
        data["exhaust_primaries"][2]["wall_temperature"] = serde_json::json!(700.0);
        data["intake_pipes"][3]["diameter_out"] = serde_json::json!(0.041);
        let p = write_temp(&data);
        let cfg = load_v1_json(&p).unwrap();
        let _ = fs::remove_file(&p);
        assert_eq!(cfg.secondary_lengths.as_ref().unwrap()[1], 0.5);
        assert_eq!(cfg.secondary_diameters_out.as_ref().unwrap()[1], Some(0.042));
        assert_eq!(cfg.primary_wall_ts.as_ref().unwrap()[2], 700.0);
        assert_eq!(cfg.runner_diameters_out.as_ref().unwrap()[3], Some(0.041));
    }

    #[test]
    fn a_tapered_pipe_does_not_leak_its_taper_onto_the_straight_ones() {
        // The scalar `runner_diameter_out` is seeded from pipe 0, so when the
        // per-pipe vector exists a `None` entry must mean "straight" (d_out =
        // d_in) rather than falling back to pipe 0's taper. Putting the taper at
        // index 0 is what exposes it — an override at any other index leaves the
        // scalar `None` and the bug stays hidden.
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        data["intake_pipes"][0]["diameter_out"] = serde_json::json!(0.041);
        let p = write_temp(&data);
        let cfg = load_v1_json(&p).unwrap();
        let _ = fs::remove_file(&p);

        let outs = cfg.runner_diameters_out.as_ref().unwrap();
        assert_eq!(outs[0], Some(0.041));
        assert!(outs[1].is_none(), "pipes 1..3 declare no taper");

        // What the SOLVER resolves, not just what the config stores.
        let (_, d_in_0, d_out_0, _, _) = cfg.runner_spec(0);
        let (_, d_in_1, d_out_1, _, _) = cfg.runner_spec(1);
        assert_eq!(d_out_0, 0.041, "the tapered pipe keeps its taper");
        assert_eq!(
            d_out_1, d_in_1,
            "a straight runner must stay straight, not inherit pipe 0's taper",
        );
        assert_ne!(d_out_0, d_in_0, "guard: pipe 0 really is tapered in this fixture");
    }

    #[test]
    fn uniform_pipe_geometry_stores_no_per_pipe_vectors() {
        // The shipped configs are uniform in every field except primary
        // inlet diameter, so mirroring the extra vectors must not change
        // what the solver sees.
        let cfg = load_v1_json(python_ref_sdm26()).unwrap();
        assert!(cfg.runner_diameters_out.is_none());
        assert!(cfg.runner_wall_ts.is_none());
        assert!(cfg.primary_diameters_out.is_none());
        assert!(cfg.primary_wall_ts.is_none());
        assert!(cfg.secondary_lengths.is_none());
        assert!(cfg.secondary_diameters_in.is_none());
        assert!(cfg.secondary_diameters_out.is_none());
        assert!(cfg.secondary_wall_ts.is_none());
    }

    #[test]
    fn non_integer_firing_order_is_schema_error_not_panic() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        // A non-integer firing-order entry used to panic via `.unwrap()`.
        data["firing_order"] = serde_json::json!([1, "two", 3, 4]);
        let p = write_temp(&data);
        let res = load_v1_json(&p);
        let _ = fs::remove_file(&p);
        assert!(matches!(res, Err(ConfigLoadError::Schema(_))));
    }

    fn load_with(data: &Value) -> (SDM26Config, Vec<String>) {
        load_v1_value(data).unwrap()
    }

    fn base() -> Value {
        serde_json::from_str(&fs::read_to_string(python_ref_sdm26()).unwrap()).unwrap()
    }

    #[test]
    fn shipped_and_parity_configs_load_without_warnings() {
        // Every config the app / parity suite ships must be warning-free,
        // otherwise the warning channel is noise.
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for rel in [
            "python_ref/configs/sdm26.json",
            "python_ref/configs/sdm25.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm25.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26-physics-v2.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm25-physics-v2.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt_exhaust.json",
            "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt_realtune.json",
            "../../apps/desktop/src/modules/cfd/editor/templates/sdm26.json",
            "../../apps/desktop/src/modules/cfd/editor/templates/sdm25.json",
        ] {
            let (_, w) = load_v1_json_with_warnings(root.join(rel)).unwrap();
            assert!(w.is_empty(), "{rel}: {w:?}");
        }
    }

    #[test]
    fn misspelled_physics_key_warns_instead_of_silently_dropping() {
        let mut data = base();
        data["physics"] = serde_json::json!({
            "intake_junction_bordacarnot": true,   // typo
            "fmep_c": 0.00075,
            "restrictor_venturi_model": "yes",     // wrong type
            "cfl": true,                           // wrong type
        });
        data["plenum"]["lenght"] = serde_json::json!(0.25); // typo
        data["intake_pipes"][0]["belmouth_radius"] = serde_json::json!(0.01); // typo
        let (cfg, w) = load_with(&data);
        assert_eq!(cfg.fmep_c, 0.00075, "valid keys still apply");
        assert!(!cfg.intake_junction_borda_carnot);
        let joined = w.join("\n");
        assert!(joined.contains("physics.intake_junction_bordacarnot"), "{joined}");
        assert!(joined.contains("physics.restrictor_venturi_model expects true/false"), "{joined}");
        assert!(joined.contains("physics.cfl expects a number"), "{joined}");
        assert!(joined.contains("plenum.lenght"), "{joined}");
        assert!(joined.contains("intake_pipes[0].belmouth_radius"), "{joined}");
        assert_eq!(w.len(), 5, "{w:?}");
    }

    #[test]
    fn drivetrain_fallback_matches_struct_default() {
        let mut data = base();
        data.as_object_mut().unwrap().remove("drivetrain_efficiency");
        let (cfg, w) = load_with(&data);
        assert_eq!(cfg.drivetrain_efficiency, SDM26Config::default().drivetrain_efficiency);
        assert!(w.iter().any(|m| m.contains("drivetrain_efficiency")));
    }

    #[test]
    fn plenum_geometry_and_new_physics_flags_load() {
        let mut data = base();
        data["plenum"]["length"] = serde_json::json!(0.2);
        data["plenum"]["n_cells"] = serde_json::json!(16);
        data["intake_pipes"][0]["bellmouth_radius"] = serde_json::json!(0.0057); // r/d = 0.15
        data["intake_pipes"][1]["entry_loss_k"] = serde_json::json!(0.5);
        data["intake_pipes"][2]["end_correction"] = serde_json::json!(0.02);
        data["physics"] = serde_json::json!({
            "intake_junction_directional_loss": true,
            "intake_runner_entry_k": 0.1,
            "restrictor_venturi_model": true,
            "restrictor_diffuser_efficiency": 0.85,
            "intake_runner_end_correction": true,
            "exhaust_collector_end_correction": true,
            "exhaust_collector_open_end_physical": true,
            "fuel_mass_from_trapped_air": true,
            "heat_release_o2_limited": true,
            "enable_residual_tracking": true,
            "valve_events_at_reference_lift": true,
            "valve_lift_shape_exponent": 1.5,
        });
        let (cfg, w) = load_with(&data);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(cfg.plenum_length, 0.2);
        assert_eq!(cfg.plenum_n_cells, 16);
        assert!(cfg.intake_junction_directional_loss && cfg.restrictor_venturi_model);
        assert_eq!(cfg.intake_runner_entry_k, 0.1);
        assert_eq!(cfg.restrictor_diffuser_efficiency, Some(0.85));
        assert!(cfg.intake_runner_end_correction && cfg.exhaust_collector_end_correction);
        assert!(cfg.exhaust_collector_open_end_physical);
        assert!(cfg.fuel_mass_from_trapped_air && cfg.heat_release_o2_limited);
        assert!(cfg.enable_residual_tracking && cfg.valve_events_at_reference_lift);
        assert_eq!(cfg.valve_lift_shape_exponent, 1.5);
        let ks = cfg.intake_runner_entry_ks.as_ref().unwrap();
        assert!((ks[0] - 0.04).abs() < 1e-12, "bellmouth r/d 0.15 -> Crane K 0.04");
        assert_eq!(ks[1], 0.5);
        assert!(ks[2].is_nan() && ks[3].is_nan());
        assert_eq!(cfg.runner_end_correction(2), 0.02);
        assert!((cfg.runner_end_correction(0) - 0.85 * 0.019).abs() < 1e-12);
    }

    #[test]
    fn physics_section_applies_the_validated_flags() {
        let text = fs::read_to_string(python_ref_sdm26()).unwrap();
        let mut data: Value = serde_json::from_str(&text).unwrap();
        data["physics"] = serde_json::json!({
            "spark_advance_rpm_slope_deg_per_krpm": 1.5,
            "duration_rpm_exp": 0.4,
            "restrictor_cd_mach_k": 0.10,
            "restrictor_loss_from_diffuser_geometry": true,
            "intake_junction_borda_carnot": true,
            "fmep_c": 0.00075,
        });
        let p = write_temp(&data);
        let cfg = load_v1_json(&p).unwrap();
        let _ = fs::remove_file(&p);
        assert_eq!(cfg.spark_advance_rpm_slope_deg_per_krpm, 1.5);
        assert_eq!(cfg.duration_rpm_exp, 0.4);
        assert_eq!(cfg.restrictor_cd_mach_k, 0.10);
        assert!(cfg.restrictor_loss_from_diffuser_geometry);
        assert!(cfg.intake_junction_borda_carnot);
        assert_eq!(cfg.fmep_c, 0.00075);
        // Untouched knobs keep their defaults — partial sections are fine.
        let def = SDM26Config::default();
        assert_eq!(cfg.fmep_a, def.fmep_a);
        assert_eq!(cfg.wiebe_a_rpm_exp, def.wiebe_a_rpm_exp);
        assert_eq!(cfg.exhaust_junction_borda_carnot, def.exhaust_junction_borda_carnot);
    }

    /// Finding 0033: shaped plenum / runner+port profiles / venturi outlet
    /// load, reach the built pipes, and keep their theory values.
    #[test]
    fn diameter_profiles_and_restrictor_outlet_load_and_build() {
        use crate::model::sdm26::{JunctionKind, SDM26Engine};
        use std::f64::consts::PI;
        let mut data = base();
        // cone 38 -> 167 mm over 0.154 m: V = pi h/12 (d0^2 + d0 d1 + d1^2)
        data["plenum"]["diameter_profile"] = serde_json::json!([[0.0, 0.038], [0.154, 0.167]]);
        data["plenum"]["n_cells"] = serde_json::json!(20);
        data["restrictor"]["outlet_diameter"] = serde_json::json!(0.038);
        for i in 0..4 {
            data["intake_pipes"][i]["length"] = serde_json::json!(0.328);
            data["intake_pipes"][i]["diameter"] = serde_json::json!(0.040);
            data["intake_pipes"][i]["n_points"] = serde_json::json!(40);
            data["intake_pipes"][i]["diameter_profile"] =
                serde_json::json!([[0.0, 0.040], [0.248, 0.036], [0.328, 0.033]]);
        }
        let (cfg, w) = load_with(&data);
        let v_cone = PI * 0.154 / 12.0 * (0.038f64.powi(2) + 0.038 * 0.167 + 0.167f64.powi(2));
        assert!((cfg.plenum_volume - v_cone).abs() < 1e-12);
        assert_eq!(cfg.plenum_length, 0.154);
        // the 1.5 L scalar in the fixture disagrees with the cone -> warned
        assert!(w.iter().any(|m| m.contains("plenum.volume")), "{w:?}");
        assert!(!w.iter().any(|m| m.contains("unknown key")), "{w:?}");
        let s = cfg.restrictor_venturi_sigma();
        assert!((s - (0.020f64 / 0.038).powi(2)).abs() < 1e-12);
        let (_, d_in, d_out, _, _) = cfg.runner_spec(0);
        assert_eq!((d_in, d_out), (0.040, 0.033));

        let eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
        let pl = &eng.pipes[eng.plenum_idx];
        let ng = pl.n_ghost;
        // cell-centre areas integrate back to the cone volume (midpoint rule)
        let v_cells: f64 = (0..pl.n_cells).map(|k| pl.area[ng + k] * pl.dx).sum();
        assert!((v_cells - v_cone).abs() / v_cone < 2e-3, "{v_cells} vs {v_cone}");
        assert!(pl.area[ng] < pl.area[ng + pl.n_cells - 1]);
        // runner: no end correction -> cell k centre at (k+0.5) dx on the profile
        let r = &eng.pipes[eng.runner_idx[0]];
        let dia = |a: f64| (4.0 * a / PI).sqrt();
        let x_mid = |k: usize| (k as f64 + 0.5) * r.dx;
        for k in [0usize, 10, 29, 35, 39] {
            let x = x_mid(k);
            let expect = if x <= 0.248 { 0.040 - 0.004 * x / 0.248 }
                         else { 0.036 - 0.003 * (x - 0.248) / 0.080 };
            assert!((dia(r.area[r.n_ghost + k]) - expect).abs() < 1e-9, "cell {k}");
        }

        // with the flanged end correction the pipe grows by delta at the
        // MOUTH (constant mouth diameter), and the port end is unchanged
        let mut c2 = cfg.clone();
        c2.intake_runner_end_correction = true;
        let delta = c2.runner_end_correction(0);
        assert!((delta - 0.85 * 0.020).abs() < 1e-12);
        let e2 = SDM26Engine::new(c2, JunctionKind::Characteristic);
        let r2 = &e2.pipes[e2.runner_idx[0]];
        assert!((r2.dx * r2.n_cells as f64 - (0.328 + delta)).abs() < 1e-12);
        assert!((dia(r2.area[r2.n_ghost]) - 0.040).abs() < 1e-12);
        let last = r2.n_ghost + r2.n_cells - 1;
        let x_last = (r2.n_cells as f64 - 0.5) * r2.dx - delta;
        let expect = 0.036 - 0.003 * (x_last - 0.248) / 0.080;
        assert!((dia(r2.area[last]) - expect).abs() < 1e-9);
    }

    #[test]
    fn bad_diameter_profiles_are_schema_errors() {
        for bad in [
            serde_json::json!([[0.0, 0.04]]),
            serde_json::json!([[0.01, 0.04], [0.2, 0.04]]),
            serde_json::json!([[0.0, 0.04], [0.2, 0.04], [0.1, 0.04]]),
            serde_json::json!([[0.0, 0.04], [0.2, -0.01]]),
            serde_json::json!([[0.0, 0.04, 1.0], [0.2, 0.04]]),
        ] {
            let mut d = base();
            d["plenum"]["diameter_profile"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "plenum {bad}");
            let mut d = base();
            d["intake_pipes"][2]["diameter_profile"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "runner {bad}");
            let mut d = base();
            d["exhaust_primaries"][1]["diameter_profile"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "primary {bad}");
            let mut d = base();
            d["exhaust_secondaries"][0]["diameter_profile"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "secondary {bad}");
            let mut d = base();
            d["exhaust_collector"]["diameter_profile"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "collector {bad}");
        }
        let mut d = base();
        d["restrictor"]["outlet_diameter"] = serde_json::json!(0.015);
        assert!(load_v1_value(&d).is_err());
    }

    #[test]
    fn local_losses_and_momentum_junction_load_and_place() {
        // Finding 0035: per-pipe lumped minor losses + momentum merge flag.
        use crate::bcs::junction_characteristic::LossMode;
        use crate::model::sdm26::{Junction, JunctionKind, SDM26Engine};
        let mut data = base();
        for i in 0..4 {
            data["intake_pipes"][i]["local_losses"] = serde_json::json!([[0.1, 0.15]]);
            data["exhaust_primaries"][i]["local_losses"] = serde_json::json!([[0.12, 0.2], [0.25, 0.2]]);
        }
        for i in 0..2 {
            data["exhaust_secondaries"][i]["local_losses"] = serde_json::json!([[0.2, 0.35]]);
        }
        data["exhaust_collector"]["local_losses"] = serde_json::json!([[0.03, 0.25], [0.1, 0.5]]);
        data["physics"] = serde_json::json!({"exhaust_junction_momentum": true, "exhaust_merge_angle_deg": 12.0});
        let (cfg, w) = load_with(&data);
        assert!(!w.iter().any(|m| m.contains("unknown key")), "{w:?}");
        assert!(cfg.exhaust_junction_momentum && (cfg.exhaust_merge_angle_deg - 12.0).abs() < 1e-12);
        assert_eq!(cfg.primary_local_losses.as_ref().unwrap()[3], vec![(0.12, 0.2), (0.25, 0.2)]);
        assert_eq!(cfg.collector_local_losses.as_ref().unwrap().len(), 2);

        let eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
        let p = &eng.pipes[eng.primary_idx[0]];
        let cells: Vec<usize> = eng.local_losses[eng.primary_idx[0]].iter().map(|&(c, _)| c - p.n_ghost).collect();
        assert_eq!(cells, vec![(0.12 / p.dx).floor() as usize, (0.25 / p.dx).floor() as usize]);
        assert!(eng.local_losses[eng.plenum_idx].is_empty());
        assert_eq!(eng.local_losses[eng.collector_idx].len(), 2);
        // exhaust junctions: momentum mode, outlet axis +x, inlets at ±12°
        let mut n_mom = 0;
        for j in &eng.junctions[1..] {
            if let Junction::Char(cj) = j {
                assert!(matches!(cj.loss_mode, LossMode::Momentum));
                let last = cj.legs.last().unwrap();
                assert_eq!(last.dir, [1.0, 0.0]);
                let a = cj.legs[0].dir[1].atan2(-cj.legs[0].dir[0]).to_degrees();
                assert!((a.abs() - 12.0).abs() < 1e-9, "inlet angle {a}");
                n_mom += 1;
            }
        }
        assert_eq!(n_mom, 3);
        // without the keys nothing changes
        let (c0, _) = load_with(&base());
        assert!(c0.runner_local_losses.is_none() && c0.collector_local_losses.is_none());
        assert!(!c0.exhaust_junction_momentum);
        let e0 = SDM26Engine::new(c0, JunctionKind::Characteristic);
        assert!(e0.local_losses.iter().all(|l| l.is_empty()));
    }

    #[test]
    fn exhaust_gas_properties_apply_to_exhaust_pipes_only() {
        // Finding 0035: burned-gas γ / R on primaries, secondaries and the
        // collector; the intake side stays air.
        use crate::model::sdm26::{JunctionKind, SDM26Engine};
        let mut data = base();
        data["physics"] = serde_json::json!({"exhaust_gas_gamma": 1.30, "exhaust_gas_r": 295.0});
        let (cfg, w) = load_with(&data);
        assert!(!w.iter().any(|m| m.contains("unknown key")), "{w:?}");
        let eng = SDM26Engine::new(cfg, JunctionKind::Characteristic);
        let mut ex: Vec<usize> = eng.primary_idx.clone();
        ex.extend(eng.secondary_idx.iter().copied());
        ex.push(eng.collector_idx);
        for &i in &ex {
            assert_eq!((eng.pipes[i].gamma, eng.pipes[i].r_gas), (1.30, 295.0), "pipe {i}");
        }
        for &i in eng.runner_idx.iter().chain(std::iter::once(&eng.plenum_idx)) {
            assert_eq!((eng.pipes[i].gamma, eng.pipes[i].r_gas), (1.4, 287.0), "pipe {i}");
        }
        for bad in [serde_json::json!({"exhaust_gas_gamma": 1.0}), serde_json::json!({"exhaust_gas_r": 0.0})] {
            let mut d = base();
            d["physics"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "{bad}");
        }
    }

    #[test]
    fn bad_local_losses_are_schema_errors() {
        for bad in [
            serde_json::json!([[0.1]]),
            serde_json::json!([[0.1, -0.2]]),
            serde_json::json!([[-0.01, 0.2]]),
            serde_json::json!([[5.0, 0.2]]),
            serde_json::json!({"x": 0.1}),
        ] {
            let mut d = base();
            d["exhaust_primaries"][0]["local_losses"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "primary {bad}");
            let mut d = base();
            d["exhaust_collector"]["local_losses"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "collector {bad}");
            let mut d = base();
            d["intake_pipes"][1]["local_losses"] = bad.clone();
            assert!(load_v1_value(&d).is_err(), "runner {bad}");
        }
    }

    #[test]
    fn exhaust_diameter_profiles_load_and_build() {
        // Finding 0034: 4-2-1 with stepped primaries, merged-cone secondaries
        // and a collector + step + muffler tail as one profiled pipe.
        use crate::model::sdm26::{JunctionKind, SDM26Engine};
        use std::f64::consts::PI;
        let mut data = base();
        let prim = serde_json::json!([[0.0, 0.0277], [0.065, 0.0293], [0.367, 0.0293], [0.377, 0.0356], [0.424, 0.0356]]);
        for i in 0..4 {
            data["exhaust_primaries"][i]["length"] = serde_json::json!(0.424);
            data["exhaust_primaries"][i]["n_points"] = serde_json::json!(47);
            data["exhaust_primaries"][i]["diameter_profile"] = prim.clone();
        }
        let sec = serde_json::json!([[0.0, 0.0504], [0.0597, 0.0356], [0.4673, 0.0356]]);
        for i in 0..2 {
            data["exhaust_secondaries"][i]["length"] = serde_json::json!(0.4673);
            data["exhaust_secondaries"][i]["n_points"] = serde_json::json!(52);
            data["exhaust_secondaries"][i]["diameter_profile"] = sec.clone();
        }
        data["exhaust_collector"]["length"] = serde_json::json!(0.6647);
        data["exhaust_collector"]["n_points"] = serde_json::json!(74);
        data["exhaust_collector"]["diameter_profile"] = serde_json::json!(
            [[0.0, 0.0504], [0.0597, 0.0356], [0.0697, 0.042], [0.1597, 0.042], [0.1697, 0.0483], [0.6647, 0.0483]]);
        let (cfg, w) = load_with(&data);
        assert!(!w.iter().any(|m| m.contains("unknown key") || m.contains("stretched")), "{w:?}");
        assert_eq!(cfg.primary_spec(0).1, 0.0277);
        assert_eq!(cfg.primary_spec(0).2, 0.0356);
        assert_eq!(cfg.collector_spec().2, 0.0483);

        let dia = |a: f64| (4.0 * a / PI).sqrt();
        let eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
        let p = &eng.pipes[eng.primary_idx[0]];
        let at = |pp: &crate::solver::state::PipeState, k: usize| dia(pp.area[pp.n_ghost + k]);
        assert!((at(p, 0) - (0.0277 + 0.0016 * 0.5 * p.dx / 0.065)).abs() < 1e-9);
        assert!((at(p, 20) - 0.0293).abs() < 1e-12);
        assert!((at(p, 46) - 0.0356).abs() < 1e-12);
        let s = &eng.pipes[eng.secondary_idx[1]];
        assert!(at(s, 0) > 0.049 && (at(s, 30) - 0.0356).abs() < 1e-12);
        // no end correction: the collector is its geometric length
        let c = &eng.pipes[eng.collector_idx];
        assert!((c.dx * c.n_cells as f64 - 0.6647).abs() < 1e-12);
        assert!((at(c, 12) - 0.042).abs() < 1e-12);
        assert!((at(c, 73) - 0.0483).abs() < 1e-12);

        // with the end correction the tail grows by 0.6133 r_out at the
        // OUTLET; the upstream profile stays put.
        let mut c2 = cfg.clone();
        c2.exhaust_collector_end_correction = true;
        let e2 = SDM26Engine::new(c2, JunctionKind::Characteristic);
        let c = &e2.pipes[e2.collector_idx];
        let delta = 0.6133 * 0.5 * 0.0483;
        assert!((c.dx * c.n_cells as f64 - (0.6647 + delta)).abs() < 1e-6);
        let x12 = 12.5 * c.dx;
        assert!(x12 > 0.0697 && x12 < 0.1597);
        assert!((at(c, 12) - 0.042).abs() < 1e-12);
        assert!((at(c, c.n_cells - 1) - 0.0483).abs() < 1e-12);
    }

    #[test]
    fn exhaust_profiles_absent_keep_legacy_pipes() {
        use crate::model::sdm26::{JunctionKind, SDM26Engine};
        let (cfg, _) = load_with(&base());
        assert!(cfg.primary_diameter_profiles.is_none());
        assert!(cfg.secondary_diameter_profiles.is_none());
        assert!(cfg.collector_diameter_profile.is_none());
        assert!(cfg.afr_map.is_none());
        let eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
        let c = &eng.pipes[eng.collector_idx];
        assert!((c.dx * c.n_cells as f64 - cfg.collector_length).abs() < 1e-12);
    }

    #[test]
    fn afr_map_loads_interpolates_and_validates() {
        let mut data = base();
        data["physics"] = serde_json::json!({
            "afr_map": [[5000.0, 10.3], [7000.0, 14.3], [9000.0, 12.7]],
        });
        let (cfg, w) = load_with(&data);
        assert!(w.is_empty(), "{w:?}");
        let map = cfg.afr_map.clone().expect("afr_map loaded");
        assert_eq!(map.len(), 3);
        let wiebe = crate::cylinder::combustion::WiebeParams {
            afr_target: cfg.afr_target,
            afr_map: cfg.afr_map.clone(),
            ..Default::default()
        };
        assert!((wiebe.afr_at(6000.0) - 12.3).abs() < 1e-12);
        assert_eq!(wiebe.afr_at(3000.0), 10.3);
        assert_eq!(wiebe.afr_at(12000.0), 12.7);
        let plain = crate::cylinder::combustion::WiebeParams { afr_target: 13.1, ..Default::default() };
        assert_eq!(plain.afr_at(8000.0), 13.1);
        for bad in [
            serde_json::json!([[7000.0, 12.0], [5000.0, 12.0]]),
            serde_json::json!([[5000.0, 0.5]]),
            serde_json::json!([[5000.0]]),
        ] {
            let mut d = base();
            d["physics"] = serde_json::json!({ "afr_map": bad.clone() });
            assert!(load_v1_value(&d).is_err(), "afr_map {bad}");
        }
    }
}
