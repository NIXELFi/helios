//! Probe per-cycle IMEP convergence at a few RPMs.
//! Goal: identify "false convergence" — IMEP appearing stable for a few
//! cycles but still drifting before cycle 30. Reports IMEP per cycle so
//! we can pick a defensible min-cycle floor for the UI defaults.

use std::env;
use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{SDM26Engine, JunctionKind};
use cfd_core::params::apply_override;

#[test]
#[ignore]
fn probe_imep_per_cycle() {
    let cfg_path = env::var("CFG").expect("set CFG env var");
    let rpms_str = env::var("RPMS").unwrap_or_else(|_| "6000,8000,10000,13000".into());
    let n_cycles: usize = env::var("CYCLES").unwrap_or_else(|_| "60".into()).parse().unwrap();

    let mut cfg = load_v1_json(&cfg_path).expect("load");

    // Apply Option B production knob set (so we're testing the recommended state)
    for (path, value) in &[
        ("intake_junction_borda_carnot", 1.0),
        ("intake_junction_loss_coef", 1.0),
        ("restrictor_loss_from_diffuser_geometry", 1.0),
        ("restrictor_cd_mach_k", 0.10),
        ("spark_advance_rpm_slope_deg_per_krpm", 1.5),
        ("duration_rpm_exp", 0.4),
        ("fmep_c", 0.00075),
    ] {
        apply_override(&mut cfg, path, *value).unwrap();
    }

    for rpm_str in rpms_str.split(',') {
        let rpm: f64 = rpm_str.trim().parse().expect("rpm");
        let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
        // tol=0.0 + min_cycles=large → never converges early; runs all N cycles.
        let result = eng.run_single_rpm(rpm, n_cycles, false, 0.0, 999, true);
        println!("\n=== RPM = {:.0}  (Option B production knob set, characteristic junction) ===", rpm);
        println!("  {:>5}  {:>8}  {:>9}  {:>8}  {:>9}", "cycle", "imep_bar", "BP [kW]", "egt [K]", "Δimep_3");
        let mut last_imeps: Vec<f64> = Vec::new();
        let mut last_egts: Vec<f64> = Vec::new();
        for cs in &result.cycle_stats {
            // 3-cycle Δimep window (max - min over last 3) — same metric as the
            // convergence check uses (looking back 3 cycles for stability)
            last_imeps.push(cs.imep_bar);
            last_egts.push(cs.egt_mean);
            let win = if last_imeps.len() >= 3 {
                let n = last_imeps.len();
                let recent = &last_imeps[n - 3..n];
                let mx = recent.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let mn = recent.iter().cloned().fold(f64::INFINITY, f64::min);
                mx - mn
            } else {
                f64::NAN
            };
            println!("  {:>5}  {:>8.3}  {:>9.3}  {:>8.1}  {:>9.4}",
                     cs.cycle, cs.imep_bar, cs.brake_power_k_w, cs.egt_mean, win);
        }
        // EGT drift summary
        let final_egt = result.cycle_stats.last().unwrap().egt_mean;
        println!("  EGT trajectory (vs final {:.1} K):", final_egt);
        for early in &[5_i64, 8, 12, 15, 20, 25, 30, 40] {
            if let Some(cs) = result.cycle_stats.iter().find(|c| c.cycle == *early) {
                let drift_k = cs.egt_mean - final_egt;
                let drift_pct = 100.0 * (cs.egt_mean - final_egt).abs() / final_egt;
                println!("    cycle {:2}: EGT = {:6.1} K  (Δ = {:+5.1} K, {:4.1}%)",
                         early, cs.egt_mean, drift_k, drift_pct);
            }
        }
        let _ = last_egts;
        // Find the smallest cycle at which the 3-cycle ΔIMEP window first
        // dropped below typical convergence thresholds.
        for &tol in &[0.05_f64, 0.02, 0.01, 0.005] {
            let mut first: Option<i64> = None;
            let mut wnd: Vec<f64> = Vec::new();
            for cs in &result.cycle_stats {
                wnd.push(cs.imep_bar);
                if wnd.len() >= 3 {
                    let n = wnd.len();
                    let recent = &wnd[n - 3..n];
                    let mx = recent.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    let mn = recent.iter().cloned().fold(f64::INFINITY, f64::min);
                    if (mx - mn) < tol {
                        first = Some(cs.cycle);
                        break;
                    }
                }
            }
            println!("  → first 3-cycle ΔIMEP < {:.3}: cycle {}",
                     tol,
                     first.map(|c| c.to_string()).unwrap_or_else(|| "never".into()));
        }
        // Compare final IMEP vs IMEP at cycle 8 (the current UI default min):
        let final_imep = result.cycle_stats.last().unwrap().imep_bar;
        for early in &[5, 8, 12, 15, 20, 25, 30] {
            if let Some(cs) = result.cycle_stats.iter().find(|c| c.cycle == *early as i64) {
                let drift_pct = 100.0 * (cs.imep_bar - final_imep).abs() / final_imep;
                println!("  IMEP @ cycle {:2}: {:.3}  vs final ({:.3}) — drift = {:5.2}%",
                         early, cs.imep_bar, final_imep, drift_pct);
            }
        }
    }
}
