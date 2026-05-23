//! Regression — finding 0004 junction-kind-imep-sensitivity.
//!
//! Finding 0004 (VALIDATED) characterised three aspects of the
//! characteristic-vs-stagnation IMEP delta on SDM26:
//!
//!   1. At K=0 (current default) the characteristic junction over-predicts
//!      brake-power at 8000 RPM by ~17 kW vs the stagnation junction (an
//!      RPM-shaped acoustic-resonance signature, peak at the 1st ram
//!      harmonic of the 0.245 m intake runner).
//!   2. Non-zero `intake_junction_loss_coef` (K) attenuates the Char delta
//!      selectively — Stag BP barely moves.
//!   3. Non-zero K breaks C9 mass conservation because the loss is applied
//!      ghost-write post-correction, not inside the residual. K=5 trips the
//!      Char band (5e-4 relative) by 100×.
//!
//! Any future change to the junction algorithm or the loss-wiring path
//! that silently moves these numbers trips this regression and forces a
//! re-validation of 0004.

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
    nonconservation_rel: f64,
}

fn run_to_settle(junction: JunctionKind, rpm: f64, k_loss: f64) -> Settled {
    let mut cfg = load_v1_json(sdm26_config_path()).expect("load sdm26.json");
    cfg.enable_residual_tracking = false;
    if k_loss != 0.0 {
        apply_override(&mut cfg, "intake_junction_loss_coef", k_loss)
            .expect("apply_override intake_junction_loss_coef");
    }
    let mut eng = SDM26Engine::new(cfg, junction);
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
        nonconservation_rel: nc_rel,
    }
}

#[test]
fn r0004_char_overpredicts_stag_at_8000_rpm() {
    // 0004 §3: at K=0 (current default), SDM26_char produces ~53 kW BP at
    // 8000 RPM while SDM26_stag gives ~36.5 kW — a +16.96 kW delta. This is
    // the acoustic-resonance signature at the runner's 1st ram harmonic and
    // is the diagnostic the K-loss probe in §4 exploits. The window is wide
    // (12 kW < Δ < 22 kW) so libm jitter / FP order do not false-fail; the
    // hard ceiling is "the gap exists and points the same direction".
    let c = run_to_settle(JunctionKind::Characteristic, 8000.0, 0.0);
    let s = run_to_settle(JunctionKind::Stagnation, 8000.0, 0.0);
    let delta = c.brake_power_kw - s.brake_power_kw;
    assert!(
        delta > 12.0 && delta < 22.0,
        "Char-Stag BP delta @ 8000 RPM = {delta:.2} kW (Char={c_bp:.2}, \
         Stag={s_bp:.2}); expected ~17 kW per 0004 §3. If the delta has \
         collapsed or grown, re-validate 0004 — the diagnosis depends on \
         this acoustic-resonance signature being present.",
        c_bp = c.brake_power_kw, s_bp = s.brake_power_kw
    );
    assert!(
        c.ve_atm > 0.95 && c.ve_atm < 1.10,
        "Char VE @ 8000 RPM = {ve:.3}; expected ~1.033 per 0004 §3.",
        ve = c.ve_atm
    );
}

#[test]
fn r0004_k_loss_attenuates_char_selectively() {
    // 0004 §4: a non-zero K_loss should cut the Char BP at 8000 RPM
    // substantially while barely touching the Stag BP. K=5 historically
    // dropped Char 53→43 (-10 kW) and Stag 36.5→35.3 (-1.2 kW). Pin those
    // directions with generous bounds.
    let c0 = run_to_settle(JunctionKind::Characteristic, 8000.0, 0.0);
    let c5 = run_to_settle(JunctionKind::Characteristic, 8000.0, 5.0);
    let s0 = run_to_settle(JunctionKind::Stagnation, 8000.0, 0.0);
    let s5 = run_to_settle(JunctionKind::Stagnation, 8000.0, 5.0);
    let dc = c0.brake_power_kw - c5.brake_power_kw;
    let ds = s0.brake_power_kw - s5.brake_power_kw;
    assert!(
        dc > 5.0,
        "K=5 should cut Char BP @ 8000 RPM by >5 kW (got {dc:.2} kW). \
         If K no longer attenuates, the inflow_loss_coef path has regressed \
         or has been moved into the residual (good news — see 0005)."
    );
    assert!(
        ds < dc / 3.0,
        "K=5 should affect Stag much less than Char — got ΔStag={ds:.2} vs \
         ΔChar={dc:.2}. The selectivity of the loss term to the characteristic \
         junction is the 0004 §4 mechanism evidence."
    );
}

#[test]
fn r0004_k_loss_preserves_c9_after_0005() {
    // INVERTED after 0005 shipped: the loss term is now applied INSIDE the
    // inter-leg Newton residual (junction_characteristic.rs hllc_mass_residual
    // applies Borda-Carnot loss to the ghost state BEFORE HLLC), so any K
    // value preserves mass conservation. Pre-0005 the same K=5 test broke
    // C9 by ~100×; pin the post-fix behavior here so a regression that
    // moves the loss back to ghost-write post-correction trips loudly.
    let c0 = run_to_settle(JunctionKind::Characteristic, 10000.0, 0.0);
    let c5 = run_to_settle(JunctionKind::Characteristic, 10000.0, 5.0);
    assert!(
        c0.nonconservation_rel.abs() < 5e-4,
        "Baseline K=0 must pass C9 char band (5e-4 rel). Got {:.3e}. \
         If this fails, finding 0003's algorithmic-floor characterization \
         has changed.",
        c0.nonconservation_rel
    );
    assert!(
        c5.nonconservation_rel.abs() < 5e-4,
        "K=5 must now pass C9 char band (5e-4 rel) — 0005 moved the loss \
         into the residual. nc_rel = {:.3e}. If this fails, the loss \
         application path has regressed (likely back to write_ghosts \
         post-correction).",
        c5.nonconservation_rel
    );
}
