// exhstations <config.json> <rpm> <cycles> [k=v ...]
// Settles cycles-1 cycles, then samples the last 720 deg every 1 deg of crank: static pressure (Pa), static temperature (K)
// and velocity (m/s) at stations along the exhaust: each primary at its start (valve), middle and end; each secondary at
// its start, middle and end; the final pipe at its start, middle and end. Columns <pipe>_<station>_{p,T,u}.
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
    let mut pipes: Vec<(String, usize)> = Vec::new();
    for (i, &k) in eng.primary_idx.iter().enumerate() { pipes.push((format!("pri{}", i + 1), k)); }
    for (i, &k) in eng.secondary_idx.iter().enumerate() { pipes.push((format!("sec{}", i + 1), k)); }
    pipes.push(("final".to_string(), eng.collector_idx));
    let mut h = String::from("theta_deg,t_s");
    for (n, _) in &pipes { for s in ["start", "mid", "end"] { h += &format!(",{n}_{s}_p,{n}_{s}_T,{n}_{s}_u"); } }
    println!("{h}");
    let end = cycles as f64 * 720.0; let mut next = st.theta;
    while st.theta < end {
        next += 1.0;
        let _ = eng.advance_one_cycle(rpm, &mut st, Some(next.min(end)), None, None);
        let th = st.theta - settle;
        let mut line = format!("{:.2},{:.7}", th, th / (6.0 * rpm));
        for (_, k) in &pipes {
            let p = &eng.pipes[*k]; let g = p.n_ghost;
            for c in [g, g + p.n_cells / 2, g + p.n_cells - 1] {
                let ar = p.area[c]; let rho = p.q[c*4]/ar; let u = p.q[c*4+1]/(rho*ar); let e = p.q[c*4+2]/ar; let ps = (p.gamma-1.0)*(e-0.5*rho*u*u);
                line += &format!(",{:.0},{:.1},{:.2}", ps, ps/(rho*p.r_gas), u);
            }
        }
        println!("{line}");
    }
}
