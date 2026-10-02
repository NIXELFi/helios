// exhwave <config.json> <rpm> <cycles> [k=v ...]
// Settles cycles-1 cycles, then samples the last 720 deg every 1 deg of crank (global crank angle; cylinders are
// phased by the firing order). Per cylinder i: valve mass flow out of the cylinder into the primary (kg/s, negative =
// backflow; the MEAN over the sample interval from the cylinder's mass ledger, because the instantaneous face flux
// flips between two branches from step to step when cylinder and port pressure are close), its temperature (K), cylinder pressure and temperature, and at the port end of the primary (first cell):
// static pressure (Pa), static temperature (K), velocity (m/s), mass flow (kg/s).
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
    let n = eng.cylinders.len();
    let mut h = String::from("theta_deg,t_s");
    for i in 1..=n { h += &format!(",phase{i}_deg,mdot_valve{i}_kg_s,T_valve{i}_K,p_cyl{i}_Pa,T_cyl{i}_K,p_port{i}_Pa,T_port{i}_K,u_port{i}_m_s,mdot_port{i}_kg_s"); }
    println!("{h}");
    let end = cycles as f64 * 720.0; let mut next = st.theta;
    let mut m_prev: Vec<f64> = eng.cylinders.iter().map(|c| c.state.m_exhaust_total).collect(); let mut th_prev = st.theta;
    while st.theta < end {
        next += 1.0;
        let _ = eng.advance_one_cycle(rpm, &mut st, Some(next.min(end)), None, None);
        let th = st.theta - settle;
        let mut line = format!("{:.2},{:.7}", th, th / (6.0 * rpm)); let dts = (st.theta - th_prev) / (6.0 * rpm); th_prev = st.theta;
        for i in 0..n {
            let c = &eng.cylinders[i]; let p = &eng.pipes[eng.primary_idx[i]]; let k = p.n_ghost;
            let ar = p.area[k]; let rho = p.q[k*4]/ar; let u = p.q[k*4+1]/(rho*ar); let e = p.q[k*4+2]/ar;
            let ps = (p.gamma-1.0)*(e-0.5*rho*u*u); let ts = ps/(rho*p.r_gas);
            let dm = c.state.m_exhaust_total - m_prev[i]; m_prev[i] = c.state.m_exhaust_total;
            // the ledger is zeroed at cycle boundaries; fall back to the point value for that one sample
            let mv = if dts > 0.0 && (dm / dts - c.state.mdot_exhaust).abs() < 0.5 { dm / dts } else { c.state.mdot_exhaust };
            line += &format!(",{:.1},{:.6},{:.1},{:.0},{:.1},{:.0},{:.1},{:.2},{:.6}", c.local_theta(st.theta), mv, c.state.t_exhaust, c.state.p, c.state.t, ps, ts, u, p.q[k*4+1]);
        }
        println!("{line}");
    }
}
