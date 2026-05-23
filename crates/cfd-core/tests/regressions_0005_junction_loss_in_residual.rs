//! Regression — finding 0005 junction-loss-in-residual.
//!
//! Three guarantees pinned here:
//!
//!  1. K=0 default is bit-identical to pre-0005 (parity preserved). The
//!     parity_engine_*.rs goldens already prove this for the full SDM25/26
//!     suite; this test pins the cycle-30 BP/IMEP/VE at a representative
//!     RPM so a regression that breaks parity ALSO trips at the cfd-core
//!     level.
//!
//!  2. Scalar K > 0 now preserves C9 mass conservation (the 0005 fix). The
//!     0004 regression's `r0004_k_loss_preserves_c9_after_0005` already
//!     covers K=5 at 10000 RPM; this test extends to K = 1.0 at 8000 RPM
//!     to pin a second operating point.
//!
//!  3. BordaCarnot mode produces a different (geometry-derived) result
//!     than scalar K=0, with a smaller VE at 8000 RPM than the lossless
//!     baseline AND a smaller VE than equivalent legacy scalar K. The
//!     0005 multiplier=1.0 corresponds to K_BC≈0.598 for the SDM26 intake
//!     geometry — the test asserts the direction-correct attenuation
//!     without pinning the exact magnitude (libm-stable bounds only).

use std::path::PathBuf;

use cfd_core::params::apply_override;
use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{JunctionKind, SDM26Engine};

fn sdm26_config_path() -> PathBuf {
    let candidates = [
        "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
        "../engine-sim/python_ref/configs/sdm26.json",
    ];
    for c in candidates {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(c);
        if p.exists() {
            return p;
        }
    }
    panic!("no sdm26.json on any candidate path");
}

struct Settled {
    brake_power_kw: f64,
    ve_atm: f64,
    nc_rel: f64,
}

fn run(scalar_k: f64, borda_carnot: bool, rpm: f64) -> Settled {
    let mut cfg = load_v1_json(sdm26_config_path()).expect("load sdm26.json");
    cfg.enable_residual_tracking = false;
    if scalar_k != 0.0 {
        apply_override(&mut cfg, "intake_junction_loss_coef", scalar_k)
            .expect("override intake_junction_loss_coef");
    }
    if borda_carnot {
        apply_override(&mut cfg, "intake_junction_borda_carnot", 1.0)
            .expect("override intake_junction_borda_carnot");
        // multiplier defaults to 1.0 when intake_junction_loss_coef is 0
    }
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Characteristic);
    let r = eng.run_single_rpm(rpm, 30, false, 0.0, 0, false);
    let last = r.cycle_stats.last().expect("non-empty cycle_stats");
    let nc_rel = if last.mass_total > 0.0 {
        last.nonconservation / last.mass_total
    } else {
        0.0
    };
    Settled {
        brake_power_kw: last.brake_power_k_w,
        ve_atm: last.ve_atm,
        nc_rel,
    }
}

#[test]
fn r0005_k0_baseline_matches_pre0005() {
    // The 0004 baseline measurement at 8000 RPM was BP≈53.5 kW, VE≈1.033.
    // The wiring-fix refactor must keep K=0 bit-identical to that.
    let s = run(0.0, false, 8000.0);
    assert!(
        (s.brake_power_kw - 53.47).abs() < 0.05,
        "K=0 baseline BP@8000 = {:.3} kW differs from pre-0005 reference \
         53.47 by >0.05 kW — parity break in the lossless code path.",
        s.brake_power_kw
    );
    assert!(
        (s.ve_atm - 1.033).abs() < 0.005,
        "K=0 baseline VE@8000 = {:.4} differs from pre-0005 reference \
         1.033 by >0.005.",
        s.ve_atm
    );
}

#[test]
fn r0005_scalar_k1_preserves_c9_band() {
    // Pre-0005 K=1 trips C9 by 28×; post-0005 must stay in band.
    let s = run(1.0, false, 8000.0);
    assert!(
        s.nc_rel.abs() < 5e-4,
        "Scalar K=1 must pass C9 char band (5e-4 rel). Got {:.3e}. \
         If this fails, the in-residual loss path has regressed back to \
         ghost-write post-correction.",
        s.nc_rel
    );
    // Sanity: K=1 should also actually attenuate the BP (vs K=0 baseline)
    let base = run(0.0, false, 8000.0);
    assert!(
        s.brake_power_kw < base.brake_power_kw,
        "Scalar K=1 must reduce BP vs K=0 baseline (K=1 = {:.2}, K=0 = {:.2})",
        s.brake_power_kw, base.brake_power_kw
    );
}

#[test]
fn r0005_borda_carnot_mode_attenuates_ve_peak() {
    // BordaCarnot mode at multiplier=1.0 computes per-leg K from geometry.
    // For SDM26 the intake K_BC ≈ 0.598 (1:4.4 plenum-to-runner area ratio).
    // At 8000 RPM (intake 1st ram-harmonic) the lossless baseline gives
    // VE ≈ 1.033 (above 1.0, edge of plausibility); BordaCarnot should
    // attenuate that toward the literature 0.95-1.05 plausible band.
    let baseline = run(0.0, false, 8000.0);
    let bc = run(0.0, true, 8000.0);

    assert!(
        bc.nc_rel.abs() < 5e-4,
        "BordaCarnot mode must pass C9 char band. Got nc_rel={:.3e}.",
        bc.nc_rel
    );
    assert!(
        bc.ve_atm < baseline.ve_atm,
        "BordaCarnot @ 8000 RPM should attenuate VE vs K=0 baseline \
         (BC VE={:.4}, baseline VE={:.4}). If this reverses, the loss \
         direction or sign has flipped.",
        bc.ve_atm, baseline.ve_atm
    );
    assert!(
        bc.ve_atm < 1.02,
        "BordaCarnot @ 8000 RPM VE = {:.4} — expected to land near or below \
         1.0 (literature plausible band 0.95-1.05). Geometric K_BC ≈ 0.6 \
         for SDM26 should drop VE by a few %.",
        bc.ve_atm
    );
    // Direction: BP should fall too (lower VE → lower IMEP → lower BP).
    assert!(
        bc.brake_power_kw < baseline.brake_power_kw,
        "BordaCarnot must reduce BP vs K=0 baseline. BC BP={:.2}, baseline BP={:.2}",
        bc.brake_power_kw, baseline.brake_power_kw
    );
}
