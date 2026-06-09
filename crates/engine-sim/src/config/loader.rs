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

fn unpack_cd_table(v: &Value, key: &str) -> Result<(Vec<f64>, Vec<f64>), ConfigLoadError> {
    let arr = v.get(key).and_then(|x| x.as_array()).ok_or_else(|| {
        ConfigLoadError::Schema(format!("missing array {key:?}"))
    })?;
    let mut ld = Vec::with_capacity(arr.len());
    let mut cd = Vec::with_capacity(arr.len());
    for row in arr {
        let r = row.as_array().ok_or_else(|| {
            ConfigLoadError::Schema(format!("{key} row must be a 2-array"))
        })?;
        ld.push(r[0].as_f64().ok_or_else(|| ConfigLoadError::Schema("cd_table L/D".into()))?);
        cd.push(r[1].as_f64().ok_or_else(|| ConfigLoadError::Schema("cd_table Cd".into()))?);
    }
    Ok((ld, cd))
}

fn all_same(values: &[f64]) -> bool {
    if values.is_empty() { return true; }
    values.iter().all(|v| (v - values[0]).abs() < 1e-12)
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

    let runner_lengths: Vec<f64> = runners.iter().map(|p| p["length"].as_f64().unwrap()).collect();
    let runner_diameters_in: Vec<f64> = runners.iter().map(|p| p["diameter"].as_f64().unwrap()).collect();
    let runner_diameters_out: Vec<Option<f64>> = runners.iter()
        .map(|p| p.get("diameter_out").and_then(|x| x.as_f64()))
        .collect();
    let runner_wall_ts: Vec<f64> = runners.iter().map(|p| p["wall_temperature"].as_f64().unwrap()).collect();

    let primary_lengths: Vec<f64> = primaries.iter().map(|p| p["length"].as_f64().unwrap()).collect();
    let primary_diameters_in: Vec<f64> = primaries.iter().map(|p| p["diameter"].as_f64().unwrap()).collect();
    let primary_diameters_out: Vec<Option<f64>> = primaries.iter()
        .map(|p| p.get("diameter_out").and_then(|x| x.as_f64())).collect();
    let primary_wall_ts: Vec<f64> = primaries.iter().map(|p| p["wall_temperature"].as_f64().unwrap()).collect();

    let secondary_lengths: Vec<f64> = secondaries.iter().map(|p| p["length"].as_f64().unwrap()).collect();
    let secondary_diameters_in: Vec<f64> = secondaries.iter().map(|p| p["diameter"].as_f64().unwrap()).collect();
    let secondary_diameters_out: Vec<Option<f64>> = secondaries.iter()
        .map(|p| p.get("diameter_out").and_then(|x| x.as_f64())).collect();
    let secondary_wall_ts: Vec<f64> = secondaries.iter().map(|p| p["wall_temperature"].as_f64().unwrap()).collect();

    let mut cfg = SDM26Config::default();
    cfg.bore = req_f64(cyl, "bore")?;
    cfg.stroke = req_f64(cyl, "stroke")?;
    cfg.con_rod = req_f64(cyl, "con_rod_length")?;
    cfg.cr = req_f64(cyl, "compression_ratio")?;
    cfg.n_cylinders = req_u(&data, "n_cylinders")?;
    cfg.firing_order = data["firing_order"].as_array().unwrap().iter()
        .map(|v| v.as_i64().unwrap() as i32).collect();
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

    if !all_same(&runner_lengths) { cfg.runner_lengths = Some(runner_lengths); }
    if !all_same(&runner_diameters_in) { cfg.runner_diameters_in = Some(runner_diameters_in); }
    if !all_same(&primary_lengths) { cfg.primary_lengths = Some(primary_lengths); }
    if !all_same(&primary_diameters_in) { cfg.primary_diameters_in = Some(primary_diameters_in); }
    if topology == ExhaustTopology::FourTwoOne {
        cfg.secondary_length = secondary_lengths[0];
        cfg.secondary_diameter_in = secondary_diameters_in[0];
        cfg.secondary_diameter_out = secondary_diameters_out[0];
        cfg.secondary_n_cells = req_u(&secondaries[0], "n_points")?;
        cfg.secondary_wall_t = secondary_wall_ts[0];
    }

    Ok(cfg)
}
