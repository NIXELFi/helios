//! Finding 0035 — theory regressions for the momentum-mixing exhaust merge
//! junction (`LossMode::Momentum`). Each test drives a small pipe network to
//! steady state and checks it against a closed-form result:
//!
//! * a sudden expansion A → 2A loses the Borda-Carnot (1 − A1/A2)² q1;
//! * a contraction 2A → A is (near) lossless and never GAINS stagnation
//!   pressure (the constant-static-pressure junction does, see 0032);
//! * one primary flowing into a 2-1 merge while its partner is a dead end:
//!   the partner sits BELOW the outlet static pressure by
//!   ρ w_t (w1 cos θ − w_t) (the ejector effect), where the legacy junction
//!   holds every leg at one static pressure;
//! * two equal flows merging at 0° into A_out = 2A lose nothing;
//! * a lumped minor loss K in a straight pipe removes K·q of stagnation
//!   pressure (`apply_local_losses`, bends / muffler).

use engine_sim::bcs::junction_characteristic::{CharJunctionLeg, CharacteristicJunction, LossMode};
use engine_sim::bcs::junction_cv::PipeEnd;
use engine_sim::bcs::simple::fill_reflective_left;
use engine_sim::bcs::subsonic::{fill_subsonic_inflow_left_characteristic, fill_subsonic_outflow_right};
use engine_sim::solver::sources::apply_local_losses;
use engine_sim::solver::muscl::{cfl_dt, muscl_hancock_step, LIMITER_VAN_LEER};
use engine_sim::solver::state::{
    make_pipe_state, set_uniform, PipeState, ScratchBuffers, I_E_A, I_MOM_A, I_RHO_A, N_VARS,
};

const G: f64 = 1.4;
const R: f64 = 287.0;
const PI: f64 = std::f64::consts::PI;
const P0: f64 = 101_325.0;
const T0: f64 = 300.0;

fn prim(p: &PipeState, i: usize) -> (f64, f64, f64) {
    let a = p.area[i];
    let rho = p.q[i * N_VARS + I_RHO_A] / a;
    let u = p.q[i * N_VARS + I_MOM_A] / (rho * a);
    let e = p.q[i * N_VARS + I_E_A] / a;
    (rho, u, (G - 1.0) * (e - 0.5 * rho * u * u))
}

/// (static p, compressible stagnation p, dynamic head q) of cell `i`.
fn state(p: &PipeState, i: usize) -> (f64, f64, f64) {
    let (rho, u, ps) = prim(p, i);
    let m2 = rho * u * u / (G * ps);
    let p0 = ps * (1.0 + 0.5 * (G - 1.0) * m2).powf(G / (G - 1.0));
    (ps, p0, 0.5 * rho * u * u)
}

fn pipe(d: f64, l: f64, n: usize) -> PipeState {
    let mut s = make_pipe_state(n, l, |_x| 0.25 * PI * d * d, G, R, T0, 2);
    set_uniform(&mut s, P0 / (R * T0), 0.0, P0, 0.0);
    s
}

#[derive(Clone, Copy, PartialEq)]
enum Far { Reservoir, Closed, Back }

/// Run `pipes` (each with its far-end BC) into one junction whose leg order
/// matches `pipes`; the LAST pipe is the outlet (junction at its left end),
/// every other pipe meets the junction with its right end. Returns the
/// per-pipe time-averaged (static, stagnation, q) over the last 60 ms,
/// sampled two cells from the junction face.
fn run(
    pipes_in: Vec<(PipeState, Far, [f64; 2])>, loss: LossMode, p_back: f64,
) -> Vec<(f64, f64, f64)> {
    let n = pipes_in.len();
    let mut pipes: Vec<PipeState> = pipes_in.iter().map(|(p, _, _)| p.clone()).collect();
    let mut scr: Vec<ScratchBuffers> = pipes.iter().map(ScratchBuffers::for_pipe).collect();
    let legs: Vec<CharJunctionLeg> = pipes_in.iter().enumerate().map(|(k, (_, _, dir))| {
        let end = if k == n - 1 { PipeEnd::Left } else { PipeEnd::Right };
        let mut l = CharJunctionLeg::new(k, end);
        l.dir = *dir;
        l
    }).collect();
    let mut j = CharacteristicJunction::new(legs, G, R);
    j.loss_mode = loss;
    let (t_end, t_avg) = (0.40, 0.06);
    let mut acc = vec![(0.0, 0.0, 0.0); n];
    let mut w_acc = 0.0;
    let mut t = 0.0;
    while t < t_end {
        let mut dt = f64::MAX;
        for p in &pipes {
            dt = dt.min(cfl_dt(&p.q, &p.area, p.dx, G, 0.5, p.n_ghost));
        }
        for (k, (_, far, _)) in pipes_in.iter().enumerate() {
            let p = &mut pipes[k];
            if k == n - 1 {
                fill_subsonic_outflow_right(p, p_back);
            } else {
                match far {
                    Far::Reservoir => fill_subsonic_inflow_left_characteristic(p, P0 / (R * T0), 0.0, P0, 0.0),
                    Far::Closed => fill_reflective_left(p),
                    Far::Back => unreachable!(),
                }
            }
        }
        j.fill_ghosts(&mut pipes, dt).expect("junction converges");
        for (p, sc) in pipes.iter_mut().zip(scr.iter_mut()) {
            muscl_hancock_step(
                &mut p.q, &p.area, &p.area_f, p.dx, dt, G, p.n_ghost, LIMITER_VAN_LEER,
                &mut sc.w, &mut sc.slopes, &mut sc.w_pred_l, &mut sc.w_pred_r, &mut sc.flux,
            );
        }
        t += dt;
        if t > t_end - t_avg {
            for (k, p) in pipes.iter().enumerate() {
                let i = if k == n - 1 { p.n_ghost + 2 } else { p.n_ghost + p.n_cells - 3 };
                let s = state(p, i);
                acc[k].0 += s.0 * dt;
                acc[k].1 += s.1 * dt;
                acc[k].2 += s.2 * dt;
            }
            w_acc += dt;
        }
    }
    acc.iter().map(|a| (a.0 / w_acc, a.1 / w_acc, a.2 / w_acc)).collect()
}

const D1: f64 = 0.0356; // SDM26 1.5 in secondary ID
fn d_double() -> f64 { D1 * 2f64.sqrt() }
fn back(th_deg: f64, sign: f64) -> [f64; 2] {
    let a = th_deg.to_radians() * sign;
    [-a.cos(), a.sin()]
}

#[test]
fn regressions_0035_momentum_expansion_is_borda_carnot() {
    let r = run(vec![
        (pipe(D1, 0.3, 60), Far::Reservoir, back(0.0, 1.0)),
        (pipe(d_double(), 0.3, 60), Far::Back, [1.0, 0.0]),
    ], LossMode::Momentum, 97_000.0);
    let (up, dn) = (r[0], r[1]);
    let ratio = (up.1 - dn.1) / up.2;
    eprintln!("momentum A->2A: dp0/q1 = {ratio:.3} (Borda-Carnot 0.250), q1 = {:.0} Pa", up.2);
    assert!(up.2 > 500.0, "test must carry a real dynamic head, q = {}", up.2);
    assert!((ratio - 0.25).abs() < 0.06, "A->2A dp0/q1 = {ratio:.3}, expected 0.25");
}

#[test]
fn regressions_0035_momentum_contraction_is_lossless_not_a_gain() {
    let r = run(vec![
        (pipe(d_double(), 0.3, 60), Far::Reservoir, back(0.0, 1.0)),
        (pipe(D1, 0.3, 60), Far::Back, [1.0, 0.0]),
    ], LossMode::Momentum, 97_000.0);
    let (up, dn) = (r[0], r[1]);
    let ratio = (up.1 - dn.1) / dn.2;
    eprintln!("momentum 2A->A: dp0/q2 = {ratio:.3}, q2 = {:.0} Pa", dn.2);
    assert!(dn.2 > 500.0, "q = {}", dn.2);
    assert!((-0.03..0.06).contains(&ratio), "2A->A dp0/q2 = {ratio:.3}, expected ~0 and never < 0");
}

#[test]
fn regressions_0035_idle_partner_primary_sits_below_the_outlet() {
    let th = 10.0_f64;
    let net = |loss| run(vec![
        (pipe(D1, 0.3, 60), Far::Reservoir, back(th, -1.0)),
        (pipe(D1, 0.3, 60), Far::Closed, back(th, 1.0)),
        (pipe(d_double(), 0.3, 60), Far::Back, [1.0, 0.0]),
    ], loss, 97_000.0);
    let m = net(LossMode::Momentum);
    let (q1, q_idle) = (m[0].2, m[1].2);
    // Closed-form: p_out − p_idle = ρ w_t (w1 cosθ − w_t), w_t ≈ w1/2 → (cosθ − ½)·q1.
    let expect = th.to_radians().cos() - 0.5;
    let got = (m[2].0 - m[1].0) / q1;
    eprintln!("momentum 2-1, partner dead: (p_out - p_idle)/q1 = {got:.3} (expect {expect:.3}), q1 = {q1:.0}, q_idle = {q_idle:.1}");
    assert!(q1 > 500.0 && q_idle < 0.01 * q1);
    assert!((got - expect).abs() < 0.08, "ejector suction {got:.3} vs {expect:.3}");
    let l = net(LossMode::Scalar(0.0));
    let got_l = (l[2].0 - l[1].0) / l[0].2;
    eprintln!("legacy constant-static-p 2-1: (p_out - p_idle)/q1 = {got_l:.3}");
    assert!(got_l.abs() < 0.05, "legacy junction holds one static pressure: {got_l:.3}");
}

#[test]
fn regressions_0035_symmetric_equal_merge_is_lossless() {
    let r = run(vec![
        (pipe(D1, 0.3, 60), Far::Reservoir, back(0.0, -1.0)),
        (pipe(D1, 0.3, 60), Far::Reservoir, back(0.0, 1.0)),
        (pipe(d_double(), 0.3, 60), Far::Back, [1.0, 0.0]),
    ], LossMode::Momentum, 97_000.0);
    let ratio = (r[0].1 - r[2].1) / r[0].2;
    eprintln!("momentum symmetric 0 deg merge: dp0/q1 = {ratio:.3}, q1 = {:.0}", r[0].2);
    assert!(r[0].2 > 500.0);
    assert!(ratio.abs() < 0.05, "equal 0 deg merge dp0/q1 = {ratio:.3}, expected 0");
}

#[test]
fn regressions_0035_lumped_minor_loss_removes_k_q() {
    let k_loss = 0.8;
    let mut p = pipe(D1, 0.6, 120);
    let mut sc = ScratchBuffers::for_pipe(&p);
    let cell = p.n_ghost + 60;
    let mut t = 0.0;
    let (mut up, mut dn, mut w) = ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), 0.0);
    while t < 0.4 {
        let dt = cfl_dt(&p.q, &p.area, p.dx, G, 0.5, p.n_ghost);
        fill_subsonic_inflow_left_characteristic(&mut p, P0 / (R * T0), 0.0, P0, 0.0);
        fill_subsonic_outflow_right(&mut p, 97_000.0);
        muscl_hancock_step(
            &mut p.q, &p.area, &p.area_f, p.dx, dt, G, p.n_ghost, LIMITER_VAN_LEER,
            &mut sc.w, &mut sc.slopes, &mut sc.w_pred_l, &mut sc.w_pred_r, &mut sc.flux,
        );
        apply_local_losses(&mut p.q, &p.area, p.dx, dt, &[(cell, k_loss)]);
        t += dt;
        if t > 0.34 {
            let (a, b) = (state(&p, cell - 20), state(&p, cell + 20));
            up = (up.0 + a.0 * dt, up.1 + a.1 * dt, up.2 + a.2 * dt);
            dn = (dn.0 + b.0 * dt, dn.1 + b.1 * dt, dn.2 + b.2 * dt);
            w += dt;
        }
    }
    let ratio = (up.1 - dn.1) / up.2;
    eprintln!("lumped K = {k_loss}: dp0/q = {ratio:.3}, q = {:.0} Pa", up.2 / w);
    assert!(up.2 / w > 500.0);
    assert!((ratio - k_loss).abs() < 0.05 * k_loss.max(1.0), "dp0/q = {ratio:.3}, expected {k_loss}");
}
