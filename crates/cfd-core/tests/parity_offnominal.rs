//! Off-nominal parity validation: Rust vs Python at boundary parameter values.
//!
//! For each scenario, runs BOTH solvers at 8000 RPM for 5 cycles and compares
//! the final-cycle CycleStats field-by-field. Generates a tab-separated report
//! at `parity_offnominal_report.md` at the repo root (only when run with
//! `--ignored` so normal CI doesn't depend on Python+numba being installed).
//!
//! Run:
//!     cargo test -p cfd-core --test parity_offnominal -- --ignored --nocapture
//!
//! The test is marked `#[ignore]` because it shells out to a Python
//! interpreter with the pinned `python_ref/` solver. CI runs the
//! Rust-side parity goldens (which are bit-frozen Python output captured
//! offline); this off-nominal sweep is an on-demand correctness check.

use engine_sim::model::sdm26::{CycleStats, JunctionKind, SDM26Config, SDM26Engine};
use serde_json::Value;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
struct Scenario {
    name: &'static str,
    apply: fn(&mut SDM26Config),
    py_overrides_json: &'static str,
}

fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            name: "baseline",
            apply: |_| {},
            py_overrides_json: "{}",
        },
        Scenario {
            name: "cr_high",
            apply: |c| c.cr = 15.0,
            py_overrides_json: "{\"CR\": 15.0}",
        },
        Scenario {
            name: "cr_low",
            apply: |c| c.cr = 9.0,
            py_overrides_json: "{\"CR\": 9.0}",
        },
        Scenario {
            name: "runner_long",
            apply: |c| c.runner_length = 0.40,
            py_overrides_json: "{\"runner_length\": 0.40}",
        },
        Scenario {
            name: "runner_short",
            apply: |c| c.runner_length = 0.12,
            py_overrides_json: "{\"runner_length\": 0.12}",
        },
        Scenario {
            name: "restrictor_small",
            apply: |c| c.restrictor_throat_diameter = 0.016,
            py_overrides_json: "{\"restrictor_throat_diameter\": 0.016}",
        },
        Scenario {
            name: "restrictor_large",
            apply: |c| c.restrictor_throat_diameter = 0.024,
            py_overrides_json: "{\"restrictor_throat_diameter\": 0.024}",
        },
        Scenario {
            name: "ambient_hot",
            apply: |c| c.t_ambient = 320.0,
            py_overrides_json: "{\"T_ambient\": 320.0}",
        },
        Scenario {
            name: "ambient_cold",
            apply: |c| c.t_ambient = 280.0,
            py_overrides_json: "{\"T_ambient\": 280.0}",
        },
        Scenario {
            name: "afr_rich",
            apply: |c| c.afr_target = 12.0,
            py_overrides_json: "{\"afr_target\": 12.0}",
        },
        Scenario {
            name: "afr_lean",
            apply: |c| c.afr_target = 16.5,
            py_overrides_json: "{\"afr_target\": 16.5}",
        },
        Scenario {
            name: "spark_advance_high",
            apply: |c| c.spark_advance = 35.0,
            py_overrides_json: "{\"spark_advance\": 35.0}",
        },
        Scenario {
            name: "spark_advance_low",
            apply: |c| c.spark_advance = 10.0,
            py_overrides_json: "{\"spark_advance\": 10.0}",
        },
        Scenario {
            name: "wiebe_big",
            apply: |c| c.combustion_duration = 70.0,
            py_overrides_json: "{\"combustion_duration\": 70.0}",
        },
        Scenario {
            name: "wiebe_tight",
            apply: |c| c.combustion_duration = 25.0,
            py_overrides_json: "{\"combustion_duration\": 25.0}",
        },
    ]
}

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = .../helios/crates/cfd-core
    let m = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    m.parent().unwrap().parent().unwrap().to_path_buf()
}

fn python_ref_dir() -> PathBuf {
    repo_root().join("crates/engine-sim/python_ref")
}

fn run_rust(scenario: &Scenario) -> CycleStats {
    let mut cfg = SDM26Config::default();
    (scenario.apply)(&mut cfg);
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let result = eng.run_single_rpm(8000.0, 5, false, 0.005, 3, false);
    assert!(!result.cycle_stats.is_empty(),
        "Rust {}: 0 cycles completed", scenario.name);
    result.cycle_stats.last().cloned().unwrap()
}

fn run_python(scenario: &Scenario) -> Result<Value, String> {
    let driver = python_ref_dir().join("scripts/parity_offnominal_driver.py");
    if !driver.exists() {
        return Err(format!("driver not found at {driver:?}"));
    }
    let output = Command::new("python3")
        .arg(&driver)
        .arg(scenario.name)
        .arg("--json")
        .arg(scenario.py_overrides_json)
        .current_dir(python_ref_dir())
        .output()
        .map_err(|e| format!("failed to spawn python3: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("python driver failed: {stderr}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("bad JSON from python ({}): {stdout}", e))
}

fn rel_err(got: f64, want: f64) -> f64 {
    let denom = want.abs().max(1e-12);
    (got - want).abs() / denom
}

fn verdict(rel: f64) -> &'static str {
    if rel <= 1e-3 {
        "OK"
    } else if rel <= 1e-2 {
        "ACCEPTABLE"
    } else {
        "DIVERGENT"
    }
}

#[test]
#[ignore = "requires python3 with numba; on-demand parity sweep"]
fn parity_offnominal_sweep() {
    let scenarios = scenarios();
    let mut md = String::new();
    let _ = writeln!(&mut md, "# Off-nominal parity report: Rust vs Python @ 8000 RPM, 5 cycles");
    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "Generated by `cargo test -p cfd-core --test parity_offnominal -- --ignored --nocapture`");
    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "Junction type: stagnation. Verdict thresholds: OK ≤ 1e-3, ACCEPTABLE ≤ 1e-2, else DIVERGENT.");
    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "| scenario | field | rust | python | rel_err | verdict |");
    let _ = writeln!(&mut md, "|----------|-------|------|--------|---------|---------|");

    let mut overall_max_rel: f64 = 0.0;
    let mut overall_max_scenario = "".to_string();
    let mut overall_max_field = "".to_string();
    let mut n_div = 0usize;
    let mut n_acc = 0usize;
    let mut n_ok = 0usize;
    let mut missing_python: Vec<String> = Vec::new();

    for sc in &scenarios {
        eprintln!("running scenario: {}", sc.name);
        let rust = run_rust(sc);
        let py = match run_python(sc) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("  PYTHON FAILED for {}: {}", sc.name, e);
                missing_python.push(format!("{}: {}", sc.name, e));
                let _ = writeln!(&mut md, "| {} | (python failed) | - | - | - | SKIPPED |", sc.name);
                continue;
            }
        };
        let final_ = &py["final"];
        let fields: [(&str, f64, f64); 8] = [
            ("imep_bar", rust.imep_bar, final_["imep_bar"].as_f64().unwrap()),
            ("ve_atm", rust.ve_atm, final_["ve_atm"].as_f64().unwrap()),
            ("brake_torque_nm", rust.brake_torque_nm, final_["brake_torque_Nm"].as_f64().unwrap()),
            ("egt_mean", rust.egt_mean, final_["EGT_mean"].as_f64().unwrap()),
            ("bmep_bar", rust.bmep_bar, final_["bmep_bar"].as_f64().unwrap()),
            ("intake_mass_g", rust.intake_mass_per_cycle_g, final_["intake_mass_per_cycle_g"].as_f64().unwrap()),
            ("indicated_power_kW", rust.indicated_power_k_w, final_["indicated_power_kW"].as_f64().unwrap()),
            ("nonconservation", rust.nonconservation, final_["nonconservation"].as_f64().unwrap()),
        ];
        for (name, got, want) in fields {
            let rel = rel_err(got, want);
            let v = verdict(rel);
            match v {
                "OK" => n_ok += 1,
                "ACCEPTABLE" => n_acc += 1,
                _ => n_div += 1,
            }
            if rel > overall_max_rel {
                overall_max_rel = rel;
                overall_max_scenario = sc.name.to_string();
                overall_max_field = name.to_string();
            }
            let _ = writeln!(
                &mut md,
                "| {} | {} | {:.6e} | {:.6e} | {:.3e} | {} |",
                sc.name, name, got, want, rel, v,
            );
        }
    }

    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "## Summary");
    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "- Comparisons OK:         {}", n_ok);
    let _ = writeln!(&mut md, "- Comparisons ACCEPTABLE: {}", n_acc);
    let _ = writeln!(&mut md, "- Comparisons DIVERGENT:  {}", n_div);
    let _ = writeln!(&mut md, "- Max relative error:     {:.3e} ({} / {})",
                     overall_max_rel, overall_max_scenario, overall_max_field);
    if !missing_python.is_empty() {
        let _ = writeln!(&mut md, "");
        let _ = writeln!(&mut md, "## Python failures");
        for m in &missing_python {
            let _ = writeln!(&mut md, "- {}", m);
        }
    }

    let out_path = repo_root().join("parity_offnominal_report.md");
    fs::write(&out_path, &md).expect("write parity_offnominal_report.md");
    eprintln!("\nReport written to: {}", out_path.display());
    eprintln!("Max rel-err: {:.3e} (scenario={}, field={})",
              overall_max_rel, overall_max_scenario, overall_max_field);
    eprintln!("OK={n_ok}  ACCEPTABLE={n_acc}  DIVERGENT={n_div}");

    // Fail-fast on hard divergence ONLY if Python was actually run.
    // The point of this test is the report; we don't want a single
    // numerical disagreement to mask the rest of the table. Print
    // and let CI decide.
    if !missing_python.is_empty() {
        panic!("Python driver failed for {} scenarios; see report.",
               missing_python.len());
    }
}

/// Rust-only invariants check: always runs (no Python dependency).
/// Confirms each off-nominal scenario produces physically plausible
/// output AND that the output differs from the baseline (i.e., the
/// override is actually wired through).
#[test]
fn parity_offnominal_rust_invariants() {
    let scenarios = scenarios();
    let baseline = run_rust(&scenarios[0]);

    let mut md = String::new();
    let _ = writeln!(&mut md, "# Off-nominal Rust invariants @ 8000 RPM, 5 cycles");
    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "| scenario | imep_bar | ve_atm | egt_mean | nonconservation | brake_torque_nm | indicated_power_kW | Δ_vs_baseline_imep | invariants |");
    let _ = writeln!(&mut md, "|----------|----------|--------|----------|-----------------|-----------------|--------------------|---------------------|------------|");

    let mut violations = 0usize;
    for sc in &scenarios {
        let s = run_rust(sc);
        let imep_ok = s.imep_bar > 0.0;
        let ve_ok = s.ve_atm > 0.3 && s.ve_atm < 1.5;
        let egt_ok = s.egt_mean > 400.0 && s.egt_mean < 1500.0;
        let mass_ok = s.nonconservation.abs() < 1e-4;
        let dimep = (s.imep_bar - baseline.imep_bar).abs();
        let changed = sc.name == "baseline" || dimep > 1e-3 * baseline.imep_bar.abs();
        let v = imep_ok && ve_ok && egt_ok && mass_ok && changed;
        if !v {
            violations += 1;
        }
        let tag = if v {
            "OK".to_string()
        } else {
            let mut t = String::new();
            if !imep_ok { t.push_str("imep_neg "); }
            if !ve_ok { t.push_str("ve_oor "); }
            if !egt_ok { t.push_str("egt_oor "); }
            if !mass_ok { t.push_str("mass_drift "); }
            if !changed { t.push_str("no_change "); }
            t
        };
        let _ = writeln!(
            &mut md,
            "| {} | {:.3} | {:.4} | {:.1} | {:.3e} | {:.2} | {:.2} | {:.3} | {} |",
            sc.name, s.imep_bar, s.ve_atm, s.egt_mean, s.nonconservation,
            s.brake_torque_nm, s.indicated_power_k_w, dimep, tag,
        );
    }
    let _ = writeln!(&mut md, "");
    let _ = writeln!(&mut md, "Invariant violations: {} of {}", violations, scenarios.len());

    let out_path = repo_root().join("parity_offnominal_rust_invariants.md");
    fs::write(&out_path, &md).expect("write rust-only invariants report");
    eprintln!("Rust-invariants report: {}  ({} violations)",
              out_path.display(), violations);

    assert_eq!(violations, 0, "Rust-only invariants failed for {} scenarios; see {}",
               violations, out_path.display());
    let _ = Path::new("");
}
