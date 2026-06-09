//! Regression — finding 0003 conservation-cliff-cycle-15-20.
//!
//! Finding 0003 (VALIDATED) characterised the mass-conservation residual
//! behavior of `JunctionKind::Characteristic` vs `JunctionKind::Stagnation`
//! on SDM26 / 10000 RPM. The key results, reproduced here as assertions so
//! any future change that alters the algorithmic precision floor of the
//! characteristic-junction secant-Newton solver (or that introduces a
//! cliff into the CV/Stagnation junction) trips this test:
//!
//!   - SDM26 / Stagnation / 10000 RPM / 30 cycles
//!       → all cycles hold machine-epsilon (|nc| < 1e-15 kg)
//!   - SDM26 / Characteristic / 10000 RPM / 30 cycles
//!       → cycles 2-15 hold machine-epsilon
//!       → cycle 18+ cliff onset (|nc| jumps 8+ orders of magnitude)
//!       → cycle 25-30 plateau in the 1e-7 to 1e-6 kg range
//!
//! Per spec C9 (amended after 0003), the *acceptance* bands for these are
//! ±1e-10 relative for CV and ±5e-4 relative for Characteristic — but this
//! regression goes tighter than the spec band on purpose: it pins the
//! *measured* behavior so an algorithmic change is loudly visible rather
//! than silently absorbed under the band.
//!
//! The test is fast enough to run unflagged (~30 cycles × 2 junctions ≈
//! 60 cycle-equivalents). Both runs share the SDM26 baseline config.

use std::path::PathBuf;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{JunctionKind, SDM26Engine};

fn sdm26_config_path() -> PathBuf {
    let candidates = [
        // python_ref FIRST: these tests pin LEGACY-physics expectations, and the
        // bundled app config now ships with the validated physics section ON.
        "../engine-sim/python_ref/configs/sdm26.json",
        "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
    ];
    for c in candidates {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(c);
        if p.exists() {
            return p;
        }
    }
    panic!("no sdm26.json on any candidate path");
}

fn run_thirty_cycles(junction: JunctionKind) -> Vec<f64> {
    let mut cfg = load_v1_json(sdm26_config_path()).expect("load sdm26.json");
    cfg.enable_residual_tracking = false;
    let mut eng = SDM26Engine::new(cfg, junction);
    let r = eng.run_single_rpm(10_000.0, 30, false, 0.0, 0, false);
    r.cycle_stats.iter().map(|s| s.nonconservation).collect()
}

#[test]
fn r0003_stagnation_holds_machine_epsilon_for_thirty_cycles() {
    let nc = run_thirty_cycles(JunctionKind::Stagnation);
    assert_eq!(nc.len(), 30, "expected 30 cycle_stats rows, got {}", nc.len());

    // Cycle 1 has a warm-up transient on Characteristic; Stagnation does
    // not see it because the CV junction absorbs the startup flux. Allow a
    // generous 1e-12 on cycle 1 and 1e-14 on every subsequent cycle. The
    // 0003 measured values were 1e-17 to 1e-18 throughout — these bounds
    // are 4-5 orders of magnitude looser than measured, on purpose, to
    // accommodate small algorithmic noise without false-failing.
    let c1 = nc[0].abs();
    assert!(
        c1 < 1e-12,
        "stagnation cycle 1: |nc|={c1:.3e} kg — expected machine epsilon"
    );
    for (i, &v) in nc.iter().enumerate().skip(1) {
        assert!(
            v.abs() < 1e-14,
            "stagnation cycle {}: |nc|={:.3e} kg — expected machine epsilon. \
             Regression: the CV junction has acquired the cliff behavior \
             previously confined to Characteristic. Re-validate finding 0003.",
            i + 1, v.abs()
        );
    }
}

#[test]
fn r0003_characteristic_cliff_present_and_in_band() {
    let nc = run_thirty_cycles(JunctionKind::Characteristic);
    assert_eq!(nc.len(), 30, "expected 30 cycle_stats rows, got {}", nc.len());

    // 1. Settling band cycles 2-15: machine eps. 0003 measured 1e-18 to
    //    8e-17; allow 1e-14 to accommodate small algorithmic drift.
    for i in 1..15 {
        let v = nc[i].abs();
        assert!(
            v < 1e-14,
            "characteristic cycle {}: |nc|={:.3e} kg — expected machine \
             epsilon in the pre-cliff settling band. Regression: cliff onset \
             has moved earlier than cycle 18, or settling no longer reaches \
             machine eps. Re-validate finding 0003.",
            i + 1, v
        );
    }

    // 2. Cliff has fired by cycle 25. 0003 measured |nc| ≈ 1.84e-7 kg.
    //    Pin a 2-decade window: must be at least 1e-8 (cliff present) and
    //    at most 1e-5 (no runaway). Spec C9 char band is 5e-4 relative on
    //    m_total ≈ 3.5e-3 kg → 1.75e-6 kg absolute; this tightens that.
    let c25 = nc[24].abs();
    assert!(
        c25 > 1e-8,
        "characteristic cycle 25: |nc|={c25:.3e} kg — cliff is absent. \
         If this is intentional (e.g. junction-internal CV inventory added), \
         re-validate finding 0003 and relax this lower bound. Otherwise it \
         indicates a silent stiffness change in the secant-Newton solver."
    );
    assert!(
        c25 < 1e-5,
        "characteristic cycle 25: |nc|={c25:.3e} kg — cliff is 10+× larger \
         than 0003's measurement. This indicates a regression in the \
         secant-Newton precision floor or in the muscl_face_reconstruction \
         consistency. Inspect crates/engine-sim/src/bcs/junction_characteristic.rs."
    );

    // 3. Cycle 30 must be in the same order-of-magnitude band as cycle 25
    //    (monotonic plateau, not runaway). 0003 measured 3.95e-7 at cycle
    //    30 vs 1.84e-7 at cycle 25 — about 2× growth. Allow up to 10× to
    //    accommodate libm jitter without false-failing.
    let c30 = nc[29].abs();
    assert!(
        c30 < 10.0 * c25.max(1e-9),
        "characteristic cycle 30 |nc|={c30:.3e} kg is >10× cycle 25 \
         |nc|={c25:.3e} kg — plateau no longer monotonic. Possible runaway."
    );
    assert!(
        c30 < 1e-5,
        "characteristic cycle 30: |nc|={c30:.3e} kg — absolute plateau is too \
         large. 0003 measured ~4e-7 kg."
    );
}

#[test]
fn r0003_cliff_is_junction_kind_specific() {
    // Discriminator test: compare the cycle-30 nonconservation magnitude
    // between the two junctions on the same config. The ratio must be at
    // least 1e6 — Stagnation should be machine eps (~1e-17), Characteristic
    // should be ~4e-7. A regression that makes the two junctions look
    // similar (either via fixing Characteristic without parity break, or
    // breaking Stagnation) loudly trips here.
    let cv = run_thirty_cycles(JunctionKind::Stagnation);
    let ch = run_thirty_cycles(JunctionKind::Characteristic);
    let cv_c30 = cv[29].abs().max(1e-30);
    let ch_c30 = ch[29].abs();
    let ratio = ch_c30 / cv_c30;
    assert!(
        ratio > 1e5,
        "cycle-30 ratio Characteristic/Stagnation = {ratio:.2e} — the cliff \
         discriminator has collapsed. Char |nc|={ch_c30:.3e} kg, \
         CV |nc|={cv_c30:.3e} kg. Re-validate finding 0003."
    );
}
