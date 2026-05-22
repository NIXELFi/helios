//! Combined effect of all model improvements:
//!   - Bug 1: cfg.limiter wired through (minor)
//!   - Bug 2: intake_junction_loss_coef wired into JunctionCV (off by default)
//!   - Bug 3: AFR-dependent eta_comb (opt-in)
//!   - Flat-top valve lift profile (opt-in)
//!
//! Compare:
//!   A. Default config (legacy behavior, parity preserved)
//!   B. Default config + flat-top profile + AFR-aware
//!   C. With restrictor opened
//!   D. With restrictor + maximally tuned
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_combined_fixes -- --ignored --nocapture

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

fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.brake_power_k_w, cs.brake_torque_nm, cs.ve_atm),
            _ => break,
        }
    }
    last
}

fn peak(cfg: &SDM26Config) -> (f64, f64) {
    let rpms = [5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 10000.0, 11000.0, 12000.0, 13000.0, 13500.0, 14000.0];
    let mut best = (0.0, 0.0);
    for &rpm in &rpms {
        let (kw, _, _) = run(cfg, rpm, 6);
        if kw > best.0 { best = (kw, rpm); }
    }
    best
}

#[test]
#[ignore]
fn final_summary() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== Final model-improvement summary ===\n");
    println!("Pre-fix vs Post-fix peak power, restricted + unrestricted.\n");
    println!("Real-world: FSAE-restricted CBR600 ≈ 41-52 kW, unrestricted stock ≈ 88 kW.\n");

    // A: legacy default (parity-preserving)
    let (pa, ra) = peak(&base);
    println!("A. Default (legacy, sin² lift, no AFR-quench)");
    println!("   Restricted (20mm):     {:.2} kW @ {:.0} RPM", pa, ra);

    let open = unrestricted(&base);
    let (pa_open, ra_open) = peak(&open);
    println!("   Unrestricted:          {:.2} kW @ {:.0} RPM", pa_open, ra_open);

    // B: with flat-top profile + AFR aware
    let mut b = base.clone();
    b.intake_lift_flat_top_ramp = 0.25;
    b.exhaust_lift_flat_top_ramp = 0.25;
    b.afr_eta_enabled = true;
    let (pb, rb) = peak(&b);
    let b_open = unrestricted(&b);
    let (pb_open, rb_open) = peak(&b_open);
    println!();
    println!("B. + flat-top lift (r=0.25) + AFR-quench enabled");
    println!("   Restricted (20mm):     {:.2} kW @ {:.0} RPM  ({:+.1}% vs A)",
        pb, rb, 100.0 * (pb - pa) / pa);
    println!("   Unrestricted:          {:.2} kW @ {:.0} RPM  ({:+.1}% vs A)",
        pb_open, rb_open, 100.0 * (pb_open - pa_open) / pa_open);

    // C: B + richer AFR (12.5) + faster Wiebe (35°)
    let mut c = b.clone();
    c.afr_target = 12.5;
    c.combustion_duration = 35.0;
    let (pc, rc) = peak(&c);
    let c_open = unrestricted(&c);
    let (pc_open, rc_open) = peak(&c_open);
    println!();
    println!("C. B + AFR 12.5 + Wiebe 35°");
    println!("   Restricted (20mm):     {:.2} kW @ {:.0} RPM  ({:+.1}% vs A)",
        pc, rc, 100.0 * (pc - pa) / pa);
    println!("   Unrestricted:          {:.2} kW @ {:.0} RPM  ({:+.1}% vs A)",
        pc_open, rc_open, 100.0 * (pc_open - pa_open) / pa_open);

    // Real-world targets
    println!();
    println!("Real-world targets:");
    println!("  Restricted (FSAE bottom): 41 kW.  C/restricted hits {:.0}% of target.",
        100.0 * pc / 41.0);
    println!("  Unrestricted (stock):     88 kW.  C/unrestricted hits {:.0}% of target.",
        100.0 * pc_open / 88.0);
}
