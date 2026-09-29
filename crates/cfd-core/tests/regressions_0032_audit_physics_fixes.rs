//! Finding 0032 (audit 0929) — theory regressions for the opt-in physics
//! fixes. Each test checks the new model against a closed-form result, not
//! against a previous simulator output:
//!
//! * fix 1 — intake junction loss DIRECTION: a steady plenum→runner flow
//!   loses K_in·q of stagnation pressure across the junction, a steady
//!   runner→plenum flow loses the Borda-Carnot (1 − A_r/A_p)²·q.
//! * fix 4 — end correction: the 1-D open end has no radiation mass, so the
//!   quarter-wave frequency of a pipe of geometric length L is c/4L and the
//!   engine must add δ (0.85·r flanged runner, 0.6133·r unflanged collector)
//!   to hit c/4(L + δ). Measured from the simulated resonance.
//! * all fixes together — SDM26 runs, conserves mass, and `default()` is
//!   untouched (parity is covered bit-exactly by the engine-sim parity suite).

use engine_sim::bcs::junction_characteristic::{CharJunctionLeg, CharacteristicJunction, LossMode};
use engine_sim::bcs::junction_cv::PipeEnd;
use engine_sim::bcs::simple::{fill_open_end_right, fill_reflective_left};
use engine_sim::bcs::subsonic::{fill_subsonic_inflow_left_characteristic, fill_subsonic_outflow_right};
use engine_sim::model::sdm26::{
    JunctionKind, SDM26Config, SDM26Engine, FLANGED_END_CORRECTION,
    LEVINE_SCHWINGER_END_CORRECTION,
};
use engine_sim::solver::muscl::{cfl_dt, muscl_hancock_step, LIMITER_VAN_LEER};
use engine_sim::solver::state::{
    make_pipe_state, set_uniform, PipeState, ScratchBuffers, I_E_A, I_MOM_A, I_RHO_A, N_VARS,
};

const G: f64 = 1.4;
const R: f64 = 287.0;
const PI: f64 = std::f64::consts::PI;

fn prim(p: &PipeState, i: usize) -> (f64, f64, f64) {
    let a = p.area[i];
    let rho = p.q[i * N_VARS + I_RHO_A] / a;
    let u = p.q[i * N_VARS + I_MOM_A] / (rho * a);
    let e = p.q[i * N_VARS + I_E_A] / a;
    (rho, u, (G - 1.0) * (e - 0.5 * rho * u * u))
}

/// Compressible stagnation pressure and dynamic head of cell `i`.
fn p0_q(p: &PipeState, i: usize) -> (f64, f64) {
    let (rho, u, ps) = prim(p, i);
    let m2 = rho * u * u / (G * ps);
    let p0 = ps * (1.0 + 0.5 * (G - 1.0) * m2).powf(G / (G - 1.0));
    (p0, 0.5 * rho * u * u)
}

fn pipe(d: f64, l: f64, n: usize, p: f64, t: f64) -> PipeState {
    let mut s = make_pipe_state(n, l, |_x| 0.25 * PI * d * d, G, R, t, 2);
    set_uniform(&mut s, p / (R * t), 0.0, p, 0.0);
    s
}

fn step_pipe(p: &mut PipeState, sc: &mut ScratchBuffers, dt: f64) {
    muscl_hancock_step(
        &mut p.q, &p.area, &p.area_f, p.dx, dt, G, p.n_ghost, LIMITER_VAN_LEER,
        &mut sc.w, &mut sc.slopes, &mut sc.w_pred_l, &mut sc.w_pred_r, &mut sc.flux,
    );
}

/// Drive a 2-leg plenum/runner junction to steady state and return the
/// stagnation-pressure drop across it divided by the runner dynamic head.
///
/// `forward = true`:  reservoir → plenum(80 mm) → junction → runner(38 mm) → p_back
/// `forward = false`: reservoir → runner(38 mm) → junction → plenum(80 mm) → p_back
fn junction_loss_ratio(forward: bool, loss: LossMode, p_back: f64) -> (f64, f64) {
    let (p0, t0) = (101_325.0, 300.0);
    let (d_up, d_dn) = if forward { (0.080, 0.038) } else { (0.038, 0.080) };
    let mut pipes = vec![pipe(d_up, 0.3, 60, p0, t0), pipe(d_dn, 0.3, 60, p0, t0)];
    let mut scr: Vec<ScratchBuffers> = pipes.iter().map(ScratchBuffers::for_pipe).collect();
    let legs = vec![CharJunctionLeg::new(0, PipeEnd::Right), CharJunctionLeg::new(1, PipeEnd::Left)];
    let mut j = CharacteristicJunction::new(legs, G, R);
    j.loss_mode = loss;
    let mut t = 0.0;
    while t < 0.25 {
        let mut dt = f64::MAX;
        for p in &pipes {
            dt = dt.min(cfl_dt(&p.q, &p.area, p.dx, G, 0.5, p.n_ghost));
        }
        let rho0 = p0 / (R * t0);
        fill_subsonic_inflow_left_characteristic(&mut pipes[0], rho0, 0.0, p0, 0.0);
        fill_subsonic_outflow_right(&mut pipes[1], p_back);
        j.fill_ghosts(&mut pipes, dt).expect("junction converges");
        for (p, sc) in pipes.iter_mut().zip(scr.iter_mut()) {
            step_pipe(p, sc, dt);
        }
        t += dt;
    }
    // Sample two cells away from the junction face on each side.
    let up = &pipes[0];
    let dn = &pipes[1];
    let (p0_up, q_up) = p0_q(up, up.n_ghost + up.n_cells - 3);
    let (p0_dn, q_dn) = p0_q(dn, dn.n_ghost + 2);
    let q_runner = if forward { q_dn } else { q_up };
    ((p0_up - p0_dn) / q_runner, q_runner)
}

#[test]
fn regressions_0032_junction_entry_loss_on_plenum_to_runner_flow() {
    let k_in = 0.30;
    let (ratio, q) = junction_loss_ratio(
        true, LossMode::Directional { entry_k: k_in, expansion_multiplier: 1.0 }, 99_000.0,
    );
    eprintln!("directional forward: dp0/q = {ratio:.3} (K_in {k_in}), q = {q:.0} Pa");
    assert!(q > 200.0, "test must carry a real dynamic head, q = {q}");
    assert!((ratio - k_in).abs() < 0.08, "plenum→runner Δp0/q = {ratio:.3}, expected K_in = {k_in}");
}

#[test]
fn regressions_0032_junction_borda_carnot_on_runner_to_plenum_flow() {
    let sigma = (0.038_f64 / 0.080).powi(2);
    let k_bc = (1.0 - sigma).powi(2);
    let (ratio, q) = junction_loss_ratio(
        false, LossMode::Directional { entry_k: 0.04, expansion_multiplier: 1.0 }, 99_000.0,
    );
    eprintln!("directional backflow: dp0/q = {ratio:.3} (Borda-Carnot {k_bc:.3}), q = {q:.0} Pa");
    assert!(q > 200.0, "q = {q}");
    assert!((ratio - k_bc).abs() < 0.08, "runner→plenum Δp0/q = {ratio:.3}, expected Borda-Carnot {k_bc:.3}");
}

#[test]
fn regressions_0032_legacy_borda_carnot_mode_had_the_direction_backwards() {
    // Documents what the new mode fixes. The legacy junction equates the
    // STATIC pressure of every leg, and the geometric Borda-Carnot mode then
    // subtracts (1 - sigma)^2 q from the CONTRACTING (plenum->runner) leg:
    //  * forward, the runner face gains the full q of stagnation pressure
    //    for free and loses only 0.6 q, so the junction nets a spurious
    //    stagnation-pressure GAIN (ratio < 0: energy is created);
    //  * backward, equal statics make the runner dump its whole q, i.e. a
    //    loss of (1 - sigma^2) q ~ 0.95 q instead of Borda-Carnot 0.60 q.
    let sigma = (0.038_f64 / 0.080).powi(2);
    let (fwd, _) = junction_loss_ratio(true, LossMode::BordaCarnot { multiplier: 1.0 }, 99_000.0);
    let (rev, _) = junction_loss_ratio(false, LossMode::BordaCarnot { multiplier: 1.0 }, 99_000.0);
    eprintln!("legacy BordaCarnot mode: forward dp0/q = {fwd:.3}, backflow dp0/q = {rev:.3}");
    assert!(fwd < 0.1, "legacy forward dp0/q = {fwd:.3}");
    assert!((rev - (1.0 - sigma * sigma)).abs() < 0.1, "legacy backflow dp0/q = {rev:.3}");
}

/// Quarter-wave resonance of a pipe closed at the left and open (|R| = 1,
/// pressure release) at the right. Returns the effective acoustic length
/// c/(4f) measured from the closed-end pressure zero crossings.
fn quarter_wave_length(l: f64, d: f64) -> f64 {
    let (pa, ta) = (101_325.0, 300.0);
    let n = 240;
    let mut p = pipe(d, l, n, pa, ta);
    // 0.2 % overpressure everywhere: the open end releases it as a
    // quarter-wave standing oscillation.
    set_uniform(&mut p, pa * 1.002 / (R * ta), 0.0, pa * 1.002, 0.0);
    let mut sc = ScratchBuffers::for_pipe(&p);
    let c = (G * R * ta).sqrt();
    let dt = 0.4 * p.dx / c;
    let probe = p.n_ghost;
    let mut t = 0.0;
    let mut prev = prim(&p, probe).2 - pa;
    let mut crossings: Vec<f64> = Vec::new();
    while crossings.len() < 9 && t < 0.2 {
        fill_reflective_left(&mut p);
        fill_open_end_right(&mut p, pa, 1.0);
        step_pipe(&mut p, &mut sc, dt);
        t += dt;
        let cur = prim(&p, probe).2 - pa;
        if prev > 0.0 && cur <= 0.0 || prev < 0.0 && cur >= 0.0 {
            // linear interpolation of the crossing time
            crossings.push(t - dt * cur / (cur - prev));
        }
        prev = cur;
    }
    assert!(crossings.len() >= 9, "resonance too damped to measure");
    // Consecutive zero crossings are half a period apart; skip the first
    // (start-up transient) and average the rest.
    let half_periods: Vec<f64> = crossings.windows(2).skip(1).map(|w| w[1] - w[0]).collect();
    let period = 2.0 * half_periods.iter().sum::<f64>() / half_periods.len() as f64;
    c * period / 4.0
}

#[test]
fn regressions_0032_quarter_wave_measures_the_added_end_correction() {
    // 1) The bare 1-D open end has (numerically) zero end correction.
    let l = 0.245;
    let l_meas = quarter_wave_length(l, 0.038);
    assert!((l_meas - l).abs() / l < 0.01, "bare pipe acoustic length {l_meas:.4} vs {l}");

    // 2) With the flag, SDM26's runner pipe is L + 0.85·r and the measured
    //    acoustic length recovers the flanged end correction.
    let mut cfg = SDM26Config::calibrated();
    cfg.intake_runner_end_correction = true;
    let eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let r = 0.5 * cfg.runner_diameter_in;
    let runner = &eng.pipes[eng.runner_idx[0]];
    let l_pipe = runner.dx * runner.n_cells as f64;
    assert!((l_pipe - (cfg.runner_length + FLANGED_END_CORRECTION * r)).abs() < 1e-12);
    let delta_meas = quarter_wave_length(l_pipe, cfg.runner_diameter_in) - cfg.runner_length;
    let delta_theory = FLANGED_END_CORRECTION * r;
    eprintln!("bare pipe L_ac = {l_meas:.5} (L {l}); runner delta measured {delta_meas:.5} vs {delta_theory:.5}");
    assert!(
        (delta_meas - delta_theory).abs() < 0.2 * delta_theory,
        "runner end correction measured {delta_meas:.4} m vs 0.85·r = {delta_theory:.4} m",
    );

    // 3) Collector: Levine–Schwinger 0.6133·r (NOT ·diameter).
    let mut cfg = SDM26Config::calibrated();
    cfg.collector_length = 0.100;
    cfg.exhaust_collector_end_correction = true;
    let eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let col = &eng.pipes[eng.collector_idx];
    let l_col = col.dx * col.n_cells as f64;
    let delta = LEVINE_SCHWINGER_END_CORRECTION * 0.5 * cfg.collector_diameter_in;
    assert!((l_col - (0.100 + delta)).abs() < 1e-12, "collector length {l_col}");
    assert!((delta - 0.01533).abs() < 1e-4, "0.6133 × 25 mm radius = 15.3 mm, got {delta}");
    let delta_meas = quarter_wave_length(l_col, cfg.collector_diameter_in) - 0.100;
    eprintln!("collector delta measured {delta_meas:.5} vs 0.6133 r = {delta:.5}");
    assert!((delta_meas - delta).abs() < 0.25 * delta, "collector δ measured {delta_meas:.4}");
}

fn v2_config() -> SDM26Config {
    let mut cfg = SDM26Config::calibrated();
    cfg.intake_junction_directional_loss = true;
    cfg.restrictor_venturi_model = true;
    cfg.intake_runner_end_correction = true;
    cfg.collector_length = 0.100;
    cfg.exhaust_collector_end_correction = true;
    cfg.exhaust_collector_open_end_physical = true;
    cfg.fuel_mass_from_trapped_air = true;
    cfg.heat_release_o2_limited = true;
    cfg.enable_residual_tracking = true;
    cfg.valve_events_at_reference_lift = true;
    cfg.intake_valve_open_angle = 339.0;
    cfg.intake_valve_close_angle = 584.0;
    cfg
}

#[test]
fn regressions_0032_all_fixes_run_and_conserve_mass() {
    for &rpm in &[6000.0, 11000.0] {
        let mut eng = SDM26Engine::new(v2_config(), JunctionKind::Characteristic);
        let res = eng.run_single_rpm(rpm, 8, false, 0.005, 3, false);
        let last = res.cycle_stats.last().expect("cycles ran");
        assert!(last.imep_bar.is_finite() && last.imep_bar > 5.0, "rpm {rpm}: IMEP {}", last.imep_bar);
        assert!(last.ve_atm > 0.5 && last.ve_atm < 1.3, "rpm {rpm}: VE {}", last.ve_atm);
        let rel = last.nonconservation.abs() / last.mass_in_restrictor.abs().max(1e-12);
        assert!(rel < 5e-3, "rpm {rpm}: nonconservation {rel:.2e} of restrictor mass");
    }
}

#[test]
fn regressions_0032_new_flags_default_off() {
    let d = SDM26Config::default();
    assert!(!d.intake_junction_directional_loss);
    assert!(!d.restrictor_venturi_model);
    assert!(!d.intake_runner_end_correction && !d.exhaust_collector_end_correction);
    assert!(!d.exhaust_collector_open_end_physical);
    assert!(!d.fuel_mass_from_trapped_air && !d.heat_release_o2_limited);
    assert!(!d.valve_events_at_reference_lift);
    let c = SDM26Config::calibrated();
    assert!(!c.intake_junction_directional_loss && !c.restrictor_venturi_model);
}
