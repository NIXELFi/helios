// plenumwave <config.json> <rpm> <cycles> [k=v ...]
// Settles cycles-1 cycles, then samples the last cycle every 2 deg of crank: one CSV line per sample with
// theta_deg, t_s, p_exit_Pa (static pressure in the plenum cell at the restrictor exit), mdot_exit_kg_s (flow in that
// cell = what the quasi-steady venturi boundary is delivering), p_plenum_mean_Pa.
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::*;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (mut cfg, _w) = load_v1_json_with_warnings(&a[1]).expect("load");
    let rpm: f64 = a[2].parse().unwrap(); let cycles: usize = a[3].parse().unwrap();
    for kv in &a[4..] { let (k, v) = kv.split_once('=').unwrap(); cfd_core::params::apply_override(&mut cfg, k, v.parse().unwrap()).expect(k); }
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let mut st = CycleLoopState::new(&mut eng);
    let settle = (cycles as f64 - 1.0) * 720.0;
    while st.theta < settle {
        match eng.advance_one_cycle(rpm, &mut st, Some(settle), None, None) { CycleOutcome::Cycle(_) => {}, _ => break }
    }
    println!("theta_deg,t_s,p_exit_Pa,mdot_exit_kg_s,p_plenum_mean_Pa");
    let end = cycles as f64 * 720.0; let mut next = st.theta;
    while st.theta < end {
        next += 2.0;
        let _ = eng.advance_one_cycle(rpm, &mut st, Some(next.min(end)), None, None);
        let p = &eng.pipes[eng.plenum_idx];
        let pr = |i: usize| { let ar = p.area[i]; let rho = p.q[i*4]/ar; let u = p.q[i*4+1]/(rho*ar); let e = p.q[i*4+2]/ar; (p.gamma-1.0)*(e-0.5*rho*u*u) };
        let i0 = p.n_ghost;
        let (mut s, mut n) = (0.0, 0.0);
        for c in 0..p.n_cells { s += pr(c + p.n_ghost); n += 1.0; }
        println!("{:.2},{:.7},{:.1},{:.6},{:.1}", st.theta - settle, (st.theta - settle) / (6.0 * rpm), pr(i0), p.q[i0*4+1], s / n);
    }
}
