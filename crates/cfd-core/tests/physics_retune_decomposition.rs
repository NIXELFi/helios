//! Decompose the gap between sim's default 31 kW peak and real-world
//! FSAE CBR600 dynamometer numbers (41-52 kW). Sequentially apply each
//! suspected calibration fix and measure the cumulative power gain.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_retune_decomposition \
//!     -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

/// Run a single RPM for `n_cycles` warmup; return last-cycle brake power (kW)
/// and IMEP (bar).
fn run(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64) {
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => {
                last = (cs.brake_power_k_w, cs.imep_bar, cs.ve_atm);
            }
            _ => break,
        }
    }
    last
}

/// Apply uniform runner length to all 4 intakes (broadcast).
fn set_runner_length(cfg: &mut SDM26Config, l: f64) {
    cfg.runner_length = l;
    if let Some(v) = cfg.runner_lengths.as_mut() {
        for x in v.iter_mut() { *x = l; }
    }
}

/// Sweep RPM and find peak brake power.
fn peak_power(cfg: &SDM26Config) -> (f64, f64) {
    let rpms = [5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 10000.0, 11000.0, 12000.0, 13000.0];
    let mut best_kw = 0.0;
    let mut best_rpm = 0.0;
    for &rpm in &rpms {
        let (kw, _, _) = run(cfg, rpm, 6);
        if kw > best_kw {
            best_kw = kw;
            best_rpm = rpm;
        }
    }
    (best_kw, best_rpm)
}

#[test]
#[ignore]
fn retune_decomposition_sequential() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== Retune decomposition: chasing the FSAE CBR600 31→50 kW gap ===\n");
    println!("Each row applies ONE additional change to the previous config.\n");
    println!("{:>40}  {:>10}  {:>10}  {:>8}  {:>12}",
        "Config", "Peak kW", "@ RPM", "Δ kW", "Δ %");

    // Baseline.
    let (p0, r0) = peak_power(&base);
    println!("{:>40}  {:>10.2}  {:>10.0}  {:>8}  {:>12}",
        "0. Default", p0, r0, "—", "—");
    let mut last = p0;

    // Step 1: MBT spark advance.
    let mut c1 = base.clone();
    c1.spark_advance = 17.0;
    let (p1, r1) = peak_power(&c1);
    println!("{:>40}  {:>10.2}  {:>10.0}  {:>+8.2}  {:>+11.1}%",
        "1. + spark 25°→17° BTDC", p1, r1, p1 - last, 100.0 * (p1 - last) / last);
    last = p1;

    // Step 2: Faster Wiebe burn.
    let mut c2 = c1.clone();
    c2.combustion_duration = 35.0;
    let (p2, r2) = peak_power(&c2);
    println!("{:>40}  {:>10.2}  {:>10.0}  {:>+8.2}  {:>+11.1}%",
        "2. + Wiebe duration 50°→35°", p2, r2, p2 - last, 100.0 * (p2 - last) / last);
    last = p2;

    // Step 3: FSAE-optimal runner length.
    let mut c3 = c2.clone();
    set_runner_length(&mut c3, 0.350);
    let (p3, r3) = peak_power(&c3);
    println!("{:>40}  {:>10.2}  {:>10.0}  {:>+8.2}  {:>+11.1}%",
        "3. + runner 0.245→0.35 m", p3, r3, p3 - last, 100.0 * (p3 - last) / last);
    last = p3;

    // Step 4: Looser Woschni heat loss.
    let mut c4 = c3.clone();
    c4.woschni_c1_combustion *= 0.7; // 30% less heat loss during combustion
    c4.woschni_c1_compression *= 0.7;
    let (p4, r4) = peak_power(&c4);
    println!("{:>40}  {:>10.2}  {:>10.0}  {:>+8.2}  {:>+11.1}%",
        "4. + Woschni × 0.7 (less heat loss)", p4, r4, p4 - last, 100.0 * (p4 - last) / last);
    last = p4;

    // Step 5: Larger AFR target (richer).
    let mut c5 = c4.clone();
    c5.afr_target = 12.0; // richer
    let (p5, r5) = peak_power(&c5);
    println!("{:>40}  {:>10.2}  {:>10.0}  {:>+8.2}  {:>+11.1}%",
        "5. + AFR 13.1→12.0 (richer)", p5, r5, p5 - last, 100.0 * (p5 - last) / last);
    last = p5;

    println!();
    println!("Total: {:.2} kW → {:.2} kW ({:+.1}%)", p0, last, 100.0 * (last - p0) / p0);
    println!("Real-world FSAE CBR600 (20mm restrictor): 41-52 kW typical");
    let gap_closed = (last - p0) / (50.0 - p0);
    println!("Gap closed: {:.1}% of the {:.0}→50 kW target", 100.0 * gap_closed, p0);
}

#[test]
#[ignore]
fn rich_afr_peak_location() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== AFR rich-power peak — where does it actually land? ===\n");
    println!("Sweep AFR from very rich (9.5) to lean (16.5), at 8000 RPM.\n");
    println!("Schema currently says suggested_min=11.5 — synthesis report claims the\npeak is BELOW that. Verify empirically.\n");

    let afrs: Vec<f64> = (95..=165).step_by(5).map(|x| x as f64 / 10.0).collect();
    let mut best_kw = 0.0;
    let mut best_afr = 0.0;
    println!("{:>8}  {:>10}  {:>10}", "AFR", "Brake kW", "IMEP bar");
    for afr in afrs {
        let mut cfg = base.clone();
        cfg.afr_target = afr;
        let (kw, imep, _) = run(&cfg, 8000.0, 6);
        println!("{:>8.1}  {:>10.3}  {:>10.3}", afr, kw, imep);
        if kw > best_kw {
            best_kw = kw;
            best_afr = afr;
        }
    }
    println!("\nPeak brake power: {:.3} kW at AFR={:.1}", best_kw, best_afr);
    println!("(Schema's `suggested_min`: 11.5)");
}

#[test]
#[ignore]
fn cfl_grid_convergence_drift() {
    let base = load_v1_json(sdm26_path()).unwrap();

    println!("\n=== CFL grid-convergence drift ===\n");
    println!("Sweep CFL across [0.20, 0.95] at 8000 RPM; report IMEP drift.\n");
    println!("A converged 2nd-order scheme should be CFL-invariant within rounding.\n");

    let cfls = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95];
    println!("{:>8}  {:>10}  {:>10}  {:>10}", "CFL", "IMEP bar", "Δ vs 0.20", "Δ %");
    let mut imep_ref = 0.0;
    for (i, &cfl) in cfls.iter().enumerate() {
        let mut cfg = base.clone();
        cfg.cfl = cfl;
        let (_, imep, _) = run(&cfg, 8000.0, 6);
        if i == 0 { imep_ref = imep; }
        let dimep = imep - imep_ref;
        let dpct = 100.0 * dimep / imep_ref;
        println!("{:>8.2}  {:>10.4}  {:>+10.4}  {:>+9.2}%", cfl, imep, dimep, dpct);
    }
}
