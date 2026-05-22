//! Per-cycle mass-conservation diagnostic for finding 0003.
//!
//! Runs an SDM-family engine config for N cycles at a fixed RPM and emits
//! one NDJSON line per cycle with `nonconservation`, `mass_drift`,
//! `net_port_flow`, `mass_total`, `imep_bar`, `ve_atm`. The output
//! mirrors `helios-bench run`'s parity-safe path but is per-cycle, not
//! aggregated-to-LAST.
//!
//! Usage:
//!   cargo run --release -p helios-bench --example conservation_per_cycle -- \
//!       --config crates/engine-sim/python_ref/configs/sdm26.json \
//!       --rpm 10000 --cycles 30 --junction characteristic \
//!       --out physics_findings/0003-conservation-cliff-cycle-15-20/per_cycle_sdm26.ndjson

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{JunctionKind, SDM26Engine};
use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn parse_arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(|s| s.as_str());
        }
    }
    None
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let config_path = parse_arg(&args, "--config")
        .expect("--config <path/to/engine_config.json> required");
    let rpm: f64 = parse_arg(&args, "--rpm")
        .expect("--rpm <value> required")
        .parse()
        .expect("--rpm must be a number");
    let cycles: usize = parse_arg(&args, "--cycles")
        .expect("--cycles <N> required")
        .parse()
        .expect("--cycles must be an integer");
    let junction = parse_arg(&args, "--junction").unwrap_or("characteristic");
    let out_path = parse_arg(&args, "--out")
        .expect("--out <path> required");
    let label = parse_arg(&args, "--label").unwrap_or("");

    let junction_kind = match junction.to_ascii_lowercase().as_str() {
        "characteristic" | "char" => JunctionKind::Characteristic,
        "stagnation" | "cv" => JunctionKind::Stagnation,
        other => panic!("unknown junction kind {:?}", other),
    };

    let cfg = load_v1_json(PathBuf::from(config_path)).expect("load config");

    // Single-thread for determinism.
    std::env::set_var("RAYON_NUM_THREADS", "1");

    let mut engine = SDM26Engine::new(cfg.clone(), junction_kind);
    let result = engine.run_single_rpm(rpm, cycles, false, 0.005, 3, false);

    let mut f = File::create(out_path).expect("create output");
    // Environment header — keep parity with `helios-bench run`'s line 1.
    writeln!(
        f,
        "{{\"kind\":\"environment\",\"config\":{:?},\"rpm\":{},\"cycles\":{},\"junction\":{:?},\"label\":{:?}}}",
        config_path, rpm, cycles, junction, label
    )
    .expect("write env");

    for stats in &result.cycle_stats {
        let total_mass = if stats.mass_total != 0.0 { stats.mass_total } else { 1.0 };
        let rel = stats.nonconservation / total_mass;
        let line = serde_json::json!({
            "kind": "cycle",
            "label": label,
            "cycle": stats.cycle,
            "rpm": rpm,
            "imep_bar": stats.imep_bar,
            "ve_atm": stats.ve_atm,
            "brake_power_kW": stats.brake_power_k_w,
            "mass_total_kg": stats.mass_total,
            "mass_drift_kg": stats.mass_drift,
            "mass_in_restrictor_kg": stats.mass_in_restrictor,
            "mass_out_collector_kg": stats.mass_out_collector,
            "net_port_flow_kg": stats.net_port_flow,
            "nonconservation_kg": stats.nonconservation,
            "nonconservation_rel": rel,
        });
        writeln!(f, "{}", line).expect("write cycle");
    }

    eprintln!(
        "wrote {} cycle records ({} requested) to NDJSON",
        result.cycle_stats.len(),
        cycles
    );
}
