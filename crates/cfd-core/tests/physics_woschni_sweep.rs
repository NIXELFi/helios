//! Sensitivity of unrestricted brake power to Woschni heat-loss
//! coefficients. The bundled SDM26 has c1_gas_exchange=6.18 which is
//! notably above Heywood's standard ~2.28. Test if relaxing brings
//! the sim closer to real CBR600 numbers.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_woschni_sweep -- --ignored --nocapture

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
            CycleOutcome::Cycle(cs) => last = (cs.imep_bar, cs.brake_power_k_w),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn woschni_coefficient_sweep() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let open = unrestricted(&base);

    println!("\n=== Woschni heat-loss coefficient sweep (unrestricted) ===\n");
    println!("Default: c1_gx=6.18, c1_co=2.28, c1_cb=2.28, c2_cb=3.24e-3");
    println!("Heywood Table 12.2 typical: c1≈2.28 for all, c2≈3.24e-3\n");

    let scales = [1.0, 0.75, 0.50, 0.25];
    let rpms = [8000.0, 10000.0, 12000.0, 13500.0];

    for &rpm in &rpms {
        println!("RPM = {:.0}", rpm);
        println!("  {:>10}  {:>10}  {:>10}", "scale", "IMEP", "Brake kW");
        for &s in &scales {
            let mut c = open.clone();
            c.woschni_c1_gas_exchange *= s;
            c.woschni_c1_compression *= s;
            c.woschni_c1_combustion *= s;
            c.woschni_c2_combustion *= s;
            let (imep, kw) = run(&c, rpm, 6);
            println!("  {:>10.2}  {:>10.3}  {:>10.3}", s, imep, kw);
        }
        println!();
    }
}

#[test]
#[ignore]
fn woschni_gx_only() {
    // c1_gas_exchange is the outlier in the default — what if it alone is the issue?
    let base = load_v1_json(sdm26_path()).unwrap();
    let open = unrestricted(&base);

    println!("\n=== Just c1_gas_exchange sensitivity ===\n");
    println!("Default 6.18 is Heywood's standard? Heywood Table 12.2 shows c1=2.28 typical.\n");

    let values = [6.18, 4.0, 3.0, 2.28, 1.5];
    let rpms = [8000.0, 13500.0];

    for &rpm in &rpms {
        println!("RPM = {:.0}", rpm);
        println!("  {:>10}  {:>10}  {:>10}", "c1_gx", "IMEP", "Brake kW");
        for &v in &values {
            let mut c = open.clone();
            c.woschni_c1_gas_exchange = v;
            let (imep, kw) = run(&c, rpm, 6);
            println!("  {:>10.2}  {:>10.3}  {:>10.3}", v, imep, kw);
        }
        println!();
    }
}
