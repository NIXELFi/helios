// tipin <config.json> <rpm> <p_start_Pa> <cycles_after> [k=v ...]
// Constant-rpm throttle snap: settle 12 WOT cycles, then drop every intake-side cell (plenum + runners)
// to p_start at its own temperature (a closed-throttle manifold), then run WOT and print one JSON line
// per cycle: time since snap, brake torque, VE, mean plenum pressure.
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::*;
fn pmean(p: &engine_sim::solver::state::PipeState) -> f64 {
    let (mut s, mut n) = (0.0, 0.0);
    for c in 0..p.n_cells { let i = c + p.n_ghost; let ar = p.area[i]; let rho = p.q[i*4]/ar; let u = p.q[i*4+1]/(rho*ar); let e = p.q[i*4+2]/ar; s += (p.gamma-1.0)*(e-0.5*rho*u*u); n += 1.0; }
    s / n
}
fn tmean(p: &engine_sim::solver::state::PipeState) -> f64 {
    let (mut s, mut n) = (0.0, 0.0);
    for c in 0..p.n_cells { let i = c + p.n_ghost; let ar = p.area[i]; let rho = p.q[i*4]/ar; let u = p.q[i*4+1]/(rho*ar); let e = p.q[i*4+2]/ar; s += (p.gamma-1.0)*(e-0.5*rho*u*u)/(rho*p.r_gas); n += 1.0; }
    s / n
}
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (mut cfg, _w) = load_v1_json_with_warnings(&a[1]).expect("load");
    let rpm: f64 = a[2].parse().unwrap(); let p0: f64 = a[3].parse().unwrap(); let after: usize = a[4].parse().unwrap();
    for kv in &a[5..] { let (k, v) = kv.split_once('=').unwrap(); cfd_core::params::apply_override(&mut cfg, k, v.parse().unwrap()).expect(k); }
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let mut st = CycleLoopState::new(&mut eng);
    let settle = 12.0 * 720.0; let total = settle + after as f64 * 720.0;
    let mut bt_ss = 0.0;
    while st.theta < settle - 1e-9 {
        match eng.advance_one_cycle(rpm, &mut st, Some(total), None, None) { CycleOutcome::Cycle(s) => bt_ss = s.brake_torque_nm, _ => break }
    }
    let p_ss = pmean(&eng.pipes[eng.plenum_idx]);
    let mut idx = vec![eng.plenum_idx]; idx.extend(eng.runner_idx.iter().cloned());
    for &k in &idx {
        let p = &mut eng.pipes[k]; let g = p.gamma;
        for i in 0..(p.n_cells + 2 * p.n_ghost) {
            let ar = p.area[i]; let rho = p.q[i*4]/ar; if rho <= 0.0 { continue; }
            let u = p.q[i*4+1]/(rho*ar); let e = p.q[i*4+2]/ar; let pr = (g-1.0)*(e-0.5*rho*u*u);
            let f = p0 / pr;                       // same T, lower density, at rest
            p.q[i*4] *= f; p.q[i*4+3] *= f; p.q[i*4+1] = 0.0; p.q[i*4+2] = p0/(g-1.0)*ar;
        }
    }
    println!("{{\"cycle\":0,\"t\":0,\"bt\":null,\"p_plenum\":{:.0},\"bt_ss\":{:.4},\"p_ss\":{:.0}}}", pmean(&eng.pipes[eng.plenum_idx]), bt_ss, p_ss);
    let mut c = 0;
    while st.theta < total - 1e-9 {
        match eng.advance_one_cycle(rpm, &mut st, Some(total), None, None) {
            CycleOutcome::Cycle(s) => { c += 1;
                println!("{{\"cycle\":{},\"t\":{:.5},\"bt\":{:.4},\"ve\":{:.5},\"p_plenum\":{:.0},\"T_plenum\":{:.1},\"T_runner\":{:.1},\"res\":{:.4}}}", c, c as f64*120.0/rpm, s.brake_torque_nm, s.ve_atm, pmean(&eng.pipes[eng.plenum_idx]), tmean(&eng.pipes[eng.plenum_idx]), tmean(&eng.pipes[eng.runner_idx[0]]), s.f_residual); }
            _ => break,
        }
    }
}
