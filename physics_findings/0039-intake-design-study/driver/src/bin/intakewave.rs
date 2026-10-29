// intakewave <config.json> <rpm> <cycles> [k=v ...]
// Settles cycles-1 cycles, then samples the last 720 deg every 1 deg of crank (global crank angle; cylinders are
// phased by the firing order). Columns: restrictor mass flow, plenum static pressure at the restrictor exit, at the
// MAP port (110 mm downstream), at the runner junction (floor) and its volume mean, plenum-floor temperature; then per
// cylinder i: intake-valve mass flow INTO the cylinder (kg/s, negative = backflow; mean over the sample interval, from
// the cylinder's mass ledger), its temperature, cylinder pressure
// and temperature, and static pressure / static temperature / velocity (positive toward the cylinder) / mass flow in
// three runner cells: port = valve end (last cell), head flange (80 mm upstream of the valve) and mouth (first cell).
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
    let mut h = String::from("theta_deg,t_s,mdot_restrictor_kg_s,p_plenum_exit_Pa,p_plenum_map_Pa,p_plenum_floor_Pa,p_plenum_mean_Pa,T_plenum_floor_K");
    for i in 1..=n {
        h += &format!(",phase{i}_deg,mdot_valve{i}_kg_s,T_valve{i}_K,p_cyl{i}_Pa,T_cyl{i}_K");
        for s in ["port", "flange", "mouth"] { h += &format!(",p_{s}{i}_Pa,T_{s}{i}_K,u_{s}{i}_m_s,mdot_{s}{i}_kg_s"); }
    }
    println!("{h}");
    // (static p, static T, u, mdot) of cell k
    let cell = |p: &engine_sim::solver::state::PipeState, k: usize| { let ar = p.area[k]; let rho = p.q[k*4]/ar; let u = p.q[k*4+1]/(rho*ar); let e = p.q[k*4+2]/ar; let ps = (p.gamma-1.0)*(e-0.5*rho*u*u); (ps, ps/(rho*p.r_gas), u, p.q[k*4+1]) };
    let end = cycles as f64 * 720.0; let mut next = st.theta;
    let mut m_prev: Vec<f64> = eng.cylinders.iter().map(|c| c.state.m_intake_total).collect(); let mut th_prev = st.theta;
    while st.theta < end {
        next += 1.0;
        let _ = eng.advance_one_cycle(rpm, &mut st, Some(next.min(end)), None, None);
        let th = st.theta - settle; let dts = (st.theta - th_prev) / (6.0 * rpm); th_prev = st.theta;
        let pl = &eng.pipes[eng.plenum_idx]; let g = pl.n_ghost; let last = g + pl.n_cells - 1;
        let kmap = (g + (0.110 / pl.dx) as usize).min(last);
        let (mut s, mut m) = (0.0, 0.0); for c in g..=last { s += cell(pl, c).0; m += 1.0; }
        let mr = eng.venturi_mdot_lag.unwrap_or(pl.q[g*4+1]);
        let mut line = format!("{:.2},{:.7},{:.6},{:.0},{:.0},{:.0},{:.0},{:.1}", th, th / (6.0 * rpm), mr, cell(pl, g).0, cell(pl, kmap).0, cell(pl, last).0, s / m, cell(pl, last).1);
        for i in 0..n {
            let c = &eng.cylinders[i]; let p = &eng.pipes[eng.runner_idx[i]]; let g = p.n_ghost; let last = g + p.n_cells - 1;
            let kf = last - ((0.080 / p.dx).round() as usize).min(p.n_cells - 1);
            let dm = c.state.m_intake_total - m_prev[i]; m_prev[i] = c.state.m_intake_total;
            let mv = if dts > 0.0 && (dm / dts - c.state.mdot_intake).abs() < 0.5 { dm / dts } else { c.state.mdot_intake };
            line += &format!(",{:.1},{:.6},{:.1},{:.0},{:.1}", c.local_theta(st.theta), mv, c.state.t_intake, c.state.p, c.state.t);
            for k in [last, kf, g] { let (ps, ts, u, md) = cell(p, k); line += &format!(",{:.0},{:.1},{:.2},{:.6}", ps, ts, u, md); }
        }
        println!("{line}");
    }
}
