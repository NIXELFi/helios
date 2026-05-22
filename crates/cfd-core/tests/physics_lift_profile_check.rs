//! Verify the new flat-top lift profile produces higher VE at high
//! RPM (the high-RPM regime is where the sin² profile most under-
//! represents real cam area-under-lift).
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_lift_profile_check -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn unrestricted(cfg: &SDM26Config) -> SDM26Config {
    let mut c = cfg.clone();
    c.restrictor_throat_diameter = 0.050;
    c.restrictor_cd = 0.99;
    c.restrictor_loss_coef = 0.0;
    c
}

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.ve_atm, cs.brake_power_k_w),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn lift_profile_sweep() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let open = unrestricted(&base);

    println!("\n=== Lift profile: sin² vs flat-top (unrestricted) ===\n");
    println!("sin² area = 0.5 × max_lift × duration");
    println!("FlatTop r=0.25 area = 0.75 × max_lift × duration (+50%)\n");

    let rpms = [6000.0, 8000.0, 10000.0, 12000.0, 13500.0];
    let configs = [
        ("Sin² (default, parity)",     (0.0, 0.0)),
        ("FlatTop intake r=0.30",      (0.30, 0.0)),
        ("FlatTop intake r=0.25",      (0.25, 0.0)),
        ("FlatTop intake r=0.20",      (0.20, 0.0)),
        ("FlatTop intake+exh r=0.25",  (0.25, 0.25)),
        ("FlatTop intake+exh r=0.20",  (0.20, 0.20)),
    ];

    println!("{:>30}  | {}", "Profile",
        rpms.iter().map(|r| format!("{:>10.0}", r)).collect::<Vec<_>>().join(" "));
    for (label, (i_ramp, e_ramp)) in configs {
        let mut c = open.clone();
        c.intake_lift_flat_top_ramp = i_ramp;
        c.exhaust_lift_flat_top_ramp = e_ramp;
        let kws: Vec<f64> = rpms.iter().map(|&r| run(&c, r, 6).1).collect();
        let ves: Vec<f64> = rpms.iter().map(|&r| run(&c, r, 6).0).collect();
        let row_kw: String = kws.iter().map(|v| format!("{:>10.2}", v)).collect::<Vec<_>>().join(" ");
        let row_ve: String = ves.iter().map(|v| format!("{:>10.3}", v)).collect::<Vec<_>>().join(" ");
        println!("{:>30}  | {}  kW", label, row_kw);
        println!("{:>30}  | {}  VE", "", row_ve);
    }
}
