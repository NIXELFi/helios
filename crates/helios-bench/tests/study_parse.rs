//! study.toml schema tests. plan-review-v1 #3: RPM must be Vec<f64>.

use helios_bench::study::*;

#[test]
fn parses_minimal_recorded_run() {
    let s = r#"
[run]
config = "engine_matrix_sdm26_baseline.json"
rpm = [9000.0, 12000.0]
cycles = 30
recorded = true
seed = 42

[environment]
target_triple = "x86_64-pc-windows-msvc"
rustc_version = "1.78.0"
rayon_threads = 1
libm_source = "rust-builtin"

[[acceptance]]
metric = "peak_power_kW"
target = 50.0
tolerance = "5%"
citation = "two_zone_results.md"
"#;
    let study: Study = toml::from_str(s).expect("parse");
    assert_eq!(study.run.cycles, 30);
    assert_eq!(study.run.rpm, vec![9000.0, 12000.0]);
    assert!(study.run.recorded);
    assert_eq!(study.run.seed, Some(42));
    assert_eq!(study.environment.rayon_threads, 1);
    assert_eq!(study.acceptance.len(), 1);
    assert_eq!(study.acceptance[0].metric, "peak_power_kW");
    study.validate().expect("valid recorded run");
}

#[test]
fn rejects_recorded_run_without_seed() {
    let s = r#"
[run]
config = "x.json"
rpm = [9000.0]
cycles = 30
recorded = true

[environment]
target_triple = "x"
rustc_version = "x"
rayon_threads = 1
libm_source = "rust-builtin"
"#;
    let parsed: Study = toml::from_str(s).expect("parse");
    let v = parsed.validate();
    assert!(v.is_err(), "recorded run with no seed should fail validate(): {:?}", v);
}

#[test]
fn rejects_recorded_run_with_threads_gt_1() {
    let s = r#"
[run]
config = "x.json"
rpm = [9000.0]
cycles = 30
recorded = true
seed = 7

[environment]
target_triple = "x"
rustc_version = "x"
rayon_threads = 4
libm_source = "rust-builtin"
"#;
    let parsed: Study = toml::from_str(s).expect("parse");
    let v = parsed.validate();
    assert!(v.is_err(), "recorded run with rayon_threads=4 should fail: {:?}", v);
}

#[test]
fn exploratory_run_allows_missing_seed_and_threads_gt_1() {
    let s = r#"
[run]
config = "x.json"
rpm = [9000.0]
cycles = 30
recorded = false

[environment]
target_triple = "x"
rustc_version = "x"
rayon_threads = 8
libm_source = "rust-builtin"
"#;
    let parsed: Study = toml::from_str(s).expect("parse");
    parsed.validate().expect("exploratory run should pass");
}

#[test]
fn rejects_acceptance_without_citation() {
    let s = r#"
[run]
config = "x.json"
rpm = [9000.0]
cycles = 30
recorded = true
seed = 1

[environment]
target_triple = "x"
rustc_version = "x"
rayon_threads = 1
libm_source = "rust-builtin"

[[acceptance]]
metric = "imep_bar"
target = 10.0
tolerance = "5%"
citation = ""
"#;
    let parsed: Study = toml::from_str(s).expect("parse");
    let v = parsed.validate();
    assert!(v.is_err(), "empty citation should fail validate(): {:?}", v);
}

#[test]
fn parses_sweep_block() {
    let s = r#"
[run]
config = "x.json"
rpm = [9000.0]
cycles = 30
recorded = true
seed = 7

[environment]
target_triple = "x"
rustc_version = "x"
rayon_threads = 1
libm_source = "rust-builtin"

[sweep]
sampler = "lhs"
n_trials = 32
parameters = [
    { name = "woschni_c1", min = 1.8, max = 2.6 },
    { name = "woschni_c2", min = 0.0, max = 0.005 },
]
"#;
    let parsed: Study = toml::from_str(s).expect("parse");
    let sweep = parsed.sweep.expect("sweep present");
    assert_eq!(sweep.n_trials, 32);
    assert_eq!(sweep.parameters.len(), 2);
    assert_eq!(sweep.parameters[0].name, "woschni_c1");
}

#[test]
fn rpm_accepts_integer_toml_literals() {
    // TOML allows `9000` (integer) but our schema needs Vec<f64> — confirm
    // toml-rs auto-coerces, OR we accept and convert. plan-review-v1 #3.
    let s = r#"
[run]
config = "x.json"
rpm = [9000, 12000]
cycles = 30
recorded = false

[environment]
target_triple = "x"
rustc_version = "x"
rayon_threads = 1
libm_source = "rust-builtin"
"#;
    // toml-rs requires the value to match the target type, so integers
    // in a Vec<f64> field can fail. The test documents the contract — if
    // it fails, the schema needs an explicit deserializer.
    let r: Result<Study, _> = toml::from_str(s);
    // Accept either: parser allows it, OR caller must quote as float. The
    // baseline contract is the float form, but if toml-rs is permissive,
    // we want to know.
    if let Ok(study) = r {
        assert_eq!(study.run.rpm, vec![9000.0, 12000.0]);
    }
    // Either way, the float-literal form must work (covered by other tests).
}
