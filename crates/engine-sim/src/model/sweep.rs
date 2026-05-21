//! Full RPM sweep driver. Direct port of `models/sweep.py`.

use std::time::Instant;

use crate::model::sdm26::{JunctionKind, SDM26Config, SDM26Engine};

#[derive(Debug, Clone)]
pub struct SweepPoint {
    pub rpm: f64,
    pub converged_cycle: i64,
    pub n_cycles_run: usize,
    pub imep_bar: f64,
    pub ve_atm: f64,
    pub egt_valve_k: f64,
    pub indicated_power_k_w: f64,
    pub mass_drift_last: f64,
    pub nonconservation_last: f64,
    pub nonconservation_max: f64,
    pub wall_time_s: f64,
    pub step_count: u64,
}

pub fn run_sweep(
    rpm_list: &[f64],
    cfg: SDM26Config,
    junction_kind: JunctionKind,
    n_cycles_max: usize,
    convergence_tol_imep: f64,
    convergence_min_cycles: usize,
) -> Vec<SweepPoint> {
    let mut out = Vec::with_capacity(rpm_list.len());
    for &rpm in rpm_list {
        let mut eng = SDM26Engine::new(cfg.clone(), junction_kind);
        let t0 = Instant::now();
        let result = eng.run_single_rpm(
            rpm, n_cycles_max, false,
            convergence_tol_imep, convergence_min_cycles, true,
        );
        let wall = t0.elapsed().as_secs_f64();
        let last = result.cycle_stats.last().copied().expect("at least one cycle");
        let nonconservation_max = result.cycle_stats.iter()
            .map(|s| s.nonconservation.abs())
            .fold(0.0_f64, |a, b| a.max(b));
        out.push(SweepPoint {
            rpm,
            converged_cycle: result.converged_cycle,
            n_cycles_run: result.n_cycles_run,
            imep_bar: last.imep_bar,
            ve_atm: last.ve_atm,
            egt_valve_k: last.egt_mean,
            indicated_power_k_w: last.indicated_power_k_w,
            mass_drift_last: last.mass_drift,
            nonconservation_last: last.nonconservation,
            nonconservation_max,
            wall_time_s: wall,
            step_count: result.step_count,
        });
    }
    out
}
