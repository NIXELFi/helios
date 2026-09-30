// intakepoint <config.json> <rpm> <cycles> [k=v ...]
// Prints one JSON line: cycle-averaged (last 5) VE, brake torque, IMEP, plenum pressure, VE spread.
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::*;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (mut cfg, _w) = load_v1_json_with_warnings(&a[1]).expect("load");
    let rpm: f64 = a[2].parse().unwrap(); let cycles: usize = a[3].parse().unwrap();
    for kv in &a[4..] { let (k, v) = kv.split_once('=').unwrap(); cfd_core::params::apply_override(&mut cfg, k, v.parse().unwrap()).expect(k); }
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let mut st = CycleLoopState::new(&mut eng);
    let target = cycles as f64 * 720.0;
    let mut hist: Vec<(f64, f64, f64)> = Vec::new();
    while st.theta < target {
        match eng.advance_one_cycle(rpm, &mut st, Some(target), None, None) {
            CycleOutcome::Cycle(s) => hist.push((s.ve_atm, s.brake_torque_nm, s.imep_bar)),
            _ => break,
        }
    }
    let n = hist.len(); let k = 5.min(n); let tail = &hist[n - k..];
    let m = |f: fn(&(f64, f64, f64)) -> f64| tail.iter().map(f).sum::<f64>() / k as f64;
    let ve: Vec<f64> = hist[n.saturating_sub(6)..].iter().map(|x| x.0).collect();
    let spread = ve.iter().cloned().fold(f64::MIN, f64::max) - ve.iter().cloned().fold(f64::MAX, f64::min);
    let p = &eng.pipes[eng.plenum_idx];
    let (mut pp, mut nc) = (0.0, 0.0);
    for c in 0..p.n_cells { let i = c + p.n_ghost; let ar = p.area[i]; let rho = p.q[i*4]/ar; let u = p.q[i*4+1]/(rho*ar); let e = p.q[i*4+2]/ar; pp += (p.gamma-1.0)*(e-0.5*rho*u*u); nc += 1.0; }
    println!("{{\"rpm\":{},\"ve\":{:.5},\"bt\":{:.4},\"imep\":{:.4},\"spread\":{:.5},\"p_plenum_end\":{:.0},\"cycles\":{}}}", rpm, m(|x| x.0), m(|x| x.1), m(|x| x.2), spread, pp/nc, n);
}
