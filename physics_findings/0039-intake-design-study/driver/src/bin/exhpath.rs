// exhpath <config.json> <rpm> <cycles> <d1,d2,...> [k=v ...]
// Like exhstations, but samples at given DISTANCES (mm) from the valve along cylinder 1's path (primary 1 -> secondary 1 -> final
// pipe) and along cylinder 4's path (primary 4 -> secondary 1 -> final pipe), so stations line up with a 3D run whatever the
// pipe split is. Last 720 deg at 1 deg. Columns: theta_deg, t_s, then c1_<d>_{p,T,u,mdot} and c4_<d>_{p,T,u,mdot} for each
// distance d (static Pa, static K, m/s positive downstream, kg/s).
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::*;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (mut cfg, _w) = load_v1_json_with_warnings(&a[1]).expect("load");
    let rpm: f64 = a[2].parse().unwrap(); let cycles: usize = a[3].parse().unwrap();
    let dist: Vec<f64> = a[4].split(',').map(|s| s.parse::<f64>().unwrap() / 1000.0).collect();
    for kv in &a[5..] { let (k, v) = kv.split_once('=').unwrap(); cfd_core::params::apply_override(&mut cfg, k, v.parse().unwrap()).expect(k); }
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
    let mut st = CycleLoopState::new(&mut eng);
    let settle = (cycles as f64 - 1.0) * 720.0;
    while st.theta < settle {
        match eng.advance_one_cycle(rpm, &mut st, Some(settle), None, None) { CycleOutcome::Cycle(_) => {}, _ => break }
    }
    // (pipe index, cell index) for a distance along a path of pipes
    let locate = |eng: &SDM26Engine, path: &[usize], d: f64| -> (usize, usize) {
        let mut rem = d;
        for (j, &k) in path.iter().enumerate() {
            let p = &eng.pipes[k]; let len = p.dx * p.n_cells as f64;
            if rem < len || j == path.len() - 1 { return (k, p.n_ghost + ((rem / p.dx) as usize).min(p.n_cells - 1)); }
            rem -= len;
        }
        unreachable!()
    };
    let paths = [("c1", vec![eng.primary_idx[0], eng.secondary_idx[0], eng.collector_idx]), ("c4", vec![eng.primary_idx[3], eng.secondary_idx[0], eng.collector_idx])];
    let mut h = String::from("theta_deg,t_s"); let mut cells: Vec<(usize, usize)> = Vec::new();
    for (n, path) in &paths { for d in &dist { h += &format!(",{n}_{:.0}_p,{n}_{:.0}_T,{n}_{:.0}_u,{n}_{:.0}_mdot", d * 1000.0, d * 1000.0, d * 1000.0, d * 1000.0); cells.push(locate(&eng, path, *d)); } }
    println!("{h}");
    let end = cycles as f64 * 720.0; let mut next = st.theta;
    while st.theta < end {
        next += 1.0;
        let _ = eng.advance_one_cycle(rpm, &mut st, Some(next.min(end)), None, None);
        let th = st.theta - settle;
        let mut line = format!("{:.2},{:.7}", th, th / (6.0 * rpm));
        for &(k, c) in &cells {
            let p = &eng.pipes[k]; let ar = p.area[c]; let rho = p.q[c*4]/ar; let u = p.q[c*4+1]/(rho*ar); let e = p.q[c*4+2]/ar; let ps = (p.gamma-1.0)*(e-0.5*rho*u*u);
            line += &format!(",{:.0},{:.1},{:.2},{:.6}", ps, ps/(rho*p.r_gas), u, p.q[c*4+1]);
        }
        println!("{line}");
    }
}
