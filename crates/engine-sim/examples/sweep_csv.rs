//! One-off investigation helper: run the characteristic-junction sweep for a
//! config and print `rpm,brake_torque_nm` CSV (brake = indicated − Chen-Flynn
//! friction, same formula as model/sdm26.rs). Used to compare what the SDM25
//! and SDM26 bundled configs actually produce for the lap-sim front end.
//!
//!   cargo run -q -p engine-sim --release --example sweep_csv -- <config.json>

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::JunctionKind;
use engine_sim::model::sweep::run_sweep;

fn main() {
    let path = std::env::args().nth(1).expect("usage: sweep_csv <config.json>");
    let cfg = load_v1_json(&path).expect("load config");

    let rpms: Vec<f64> = (8..=30).map(|i| i as f64 * 500.0).collect(); // 4000..15000
    let vd = cfg.n_cylinders as f64
        * std::f64::consts::PI / 4.0
        * cfg.bore * cfg.bore
        * cfg.stroke;
    let (stroke, fa, fb, fc) = (cfg.stroke, cfg.fmep_a, cfg.fmep_b, cfg.fmep_c);

    let pts = run_sweep(&rpms, cfg, JunctionKind::Characteristic, 40, 0.005, 8);
    println!("rpm,torque_nm");
    for p in pts {
        let sp = 2.0 * stroke * p.rpm / 60.0; // mean piston speed (m/s)
        let fmep_pa = (fa + fb * sp + fc * sp * sp) * 1e5;
        let friction_w = fmep_pa * vd * p.rpm / 120.0;
        let brake_w = p.indicated_power_k_w * 1000.0 - friction_w;
        let omega = 2.0 * std::f64::consts::PI * p.rpm / 60.0;
        println!("{},{}", p.rpm, brake_w / omega);
    }
}
