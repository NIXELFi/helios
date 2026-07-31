//! V1-compatible JSON config loader. Direct port of `configs/config_loader.py`.

use std::fs;
use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::model::sdm26::{ExhaustTopology, SDM26Config};

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

fn opt_bool(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(|x| x.as_bool())
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

pub fn load_v1_json<P: AsRef<Path>>(path: P) -> Result<SDM26Config, ConfigLoadError> {
    let text = fs::read_to_string(path)?;
    let data: Value = serde_json::from_str(&text)?;

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
    cfg.restrictor_throat_diameter = req_f64(restr, "throat_diameter")?;
    cfg.restrictor_cd = req_f64(restr, "discharge_coefficient")?;
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
    cfg.drivetrain_efficiency = opt_f64(&data, "drivetrain_efficiency").unwrap_or(0.91);

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
        // Combustion phasing vs RPM (finding 0006: MBT map + Bonatesta burn
        // scaling; recommended 1.5 °/krpm and exp 0.4).
        if let Some(v) = opt_f64(phys, "spark_advance_rpm_slope_deg_per_krpm") {
            cfg.spark_advance_rpm_slope_deg_per_krpm = v;
        }
        if let Some(v) = opt_f64(phys, "spark_advance_rpm_ref") { cfg.spark_advance_rpm_ref = v; }
        if let Some(v) = opt_f64(phys, "duration_rpm_exp") { cfg.duration_rpm_exp = v; }
        if let Some(v) = opt_f64(phys, "duration_rpm_ref") { cfg.duration_rpm_ref = v; }
        if let Some(v) = opt_f64(phys, "wiebe_a_rpm_exp") { cfg.wiebe_a_rpm_exp = v; }
        if let Some(v) = opt_f64(phys, "wiebe_a_rpm_ref") { cfg.wiebe_a_rpm_ref = v; }
        if let Some(v) = opt_f64(phys, "tumble_burn_factor") { cfg.tumble_burn_factor = v; }
        // Restrictor (findings 0006/0021: Mach-dependent Cd k=0.10 for the
        // contoured nozzle + Idelchik diffuser loss from the half-angle).
        if let Some(v) = opt_f64(phys, "restrictor_cd_mach_k") { cfg.restrictor_cd_mach_k = v; }
        if let Some(v) = opt_bool(phys, "restrictor_loss_from_diffuser_geometry") {
            cfg.restrictor_loss_from_diffuser_geometry = v;
        }
        // Junction losses (finding 0005: geometry-derived Borda-Carnot,
        // applied inside the inter-leg mass residual).
        if let Some(v) = opt_f64(phys, "intake_junction_loss_coef") { cfg.intake_junction_loss_coef = v; }
        if let Some(v) = opt_bool(phys, "intake_junction_borda_carnot") { cfg.intake_junction_borda_carnot = v; }
        if let Some(v) = opt_f64(phys, "exhaust_junction_loss_coef") { cfg.exhaust_junction_loss_coef = v; }
        if let Some(v) = opt_bool(phys, "exhaust_junction_borda_carnot") { cfg.exhaust_junction_borda_carnot = v; }
        // Chen-Flynn friction (finding 0020: fmep_c 0.00075 = Heywood
        // motorcycle midpoint; the old 0.003 was 3× the literature ceiling).
        if let Some(v) = opt_f64(phys, "fmep_a") { cfg.fmep_a = v; }
        if let Some(v) = opt_f64(phys, "fmep_b") { cfg.fmep_b = v; }
        if let Some(v) = opt_f64(phys, "fmep_c") { cfg.fmep_c = v; }
        // Finding 0028: dyno-RMSE recalibration. Numerics fidelity (van Leer
        // limiter + CFL 0.5 cut the MUSCL dissipation that was damping the
        // intake/exhaust acoustics), real cam lift shape (flat-top ramp),
        // low-Re valve Cd, and the collector open-end reflection.
        if let Some(v) = phys.get("limiter").and_then(|x| x.as_i64()) { cfg.limiter = v as i32; }
        if let Some(v) = opt_f64(phys, "cfl") { cfg.cfl = v; }
        if let Some(v) = opt_f64(phys, "intake_lift_flat_top_ramp") { cfg.intake_lift_flat_top_ramp = v; }
        if let Some(v) = opt_f64(phys, "exhaust_lift_flat_top_ramp") { cfg.exhaust_lift_flat_top_ramp = v; }
        if let Some(v) = opt_bool(phys, "intake_valve_re_correction_enabled") {
            cfg.intake_valve_re_correction_enabled = v;
        }
        if let Some(v) = opt_f64(phys, "intake_valve_re_cd_min") { cfg.intake_valve_re_cd_min = v; }
        if let Some(v) = opt_f64(phys, "intake_valve_re_crit") { cfg.intake_valve_re_crit = v; }
        if let Some(v) = opt_f64(phys, "exhaust_collector_reflection_coef") {
            cfg.exhaust_collector_reflection_coef = v;
        }
        if let Some(v) = opt_bool(phys, "afr_eta_enabled") { cfg.afr_eta_enabled = v; }
        // Finding 0029: ECU-style closed-loop knock control.
        if let Some(v) = opt_bool(phys, "knock_control_enabled") { cfg.knock_control_enabled = v; }
        if let Some(v) = opt_f64(phys, "knock_integral_limit") { cfg.knock_integral_limit = v; }
        if let Some(v) = opt_f64(phys, "knock_retard_step_deg") { cfg.knock_retard_step_deg = v; }
        if let Some(v) = opt_f64(phys, "knock_max_retard_deg") { cfg.knock_max_retard_deg = v; }
        if let Some(v) = opt_f64(phys, "knock_tau_scale") { cfg.knock_tau_scale = v; }
        if let Some(v) = opt_f64(phys, "octane_number") { cfg.octane_number = v; }
        // Finding 0030: measured per-RPM ignition map, [[rpm, deg], ...].
        // Lets a config run the engine's actual ECU table instead of the
        // idealized scalar + slope tune.
        if let Some(arr) = phys.get("spark_advance_map").and_then(|x| x.as_array()) {
            let mut map: Vec<(f64, f64)> = Vec::with_capacity(arr.len());
            for row in arr {
                let r = row.as_array().ok_or_else(|| ConfigLoadError::Schema(
                    "spark_advance_map rows must be [rpm, deg] pairs".into()))?;
                if r.len() != 2 {
                    return Err(ConfigLoadError::Schema(
                        "spark_advance_map rows must be [rpm, deg] pairs".into()));
                }
                let rpm = r[0].as_f64().ok_or_else(|| ConfigLoadError::Schema(
                    "spark_advance_map rpm must be numeric".into()))?;
                let deg = r[1].as_f64().ok_or_else(|| ConfigLoadError::Schema(
                    "spark_advance_map deg must be numeric".into()))?;
                map.push((rpm, deg));
            }
            if map.windows(2).any(|w| w[1].0 <= w[0].0) {
                return Err(ConfigLoadError::Schema(
                    "spark_advance_map must be sorted by strictly increasing rpm".into()));
            }
            if !map.is_empty() { cfg.spark_advance_map = Some(map); }
        }
    }

    Ok(cfg)
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
}
