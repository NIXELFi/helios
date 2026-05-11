// Diagnostic probe for the channel resolver. Loads a CSV file the same way
// the Tauri `load_csv` IPC command does, then prints — column by column —
// what canonical channel id (if any) the resolver produced, the resolve
// path (exact alias / semantic / default), and the unit it saw.
//
// Run:
//   cargo run -p helios-csv --example probe_resolve -- <path/to/file.csv>

use std::env;
use std::path::PathBuf;

use helios_csv::{load_csv, ChannelRegistry};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: probe_resolve <path/to/file.csv>");
        std::process::exit(2);
    }
    let path = PathBuf::from(&args[1]);
    let registry_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/channels.yaml");
    let registry = ChannelRegistry::from_path(&registry_path)?;
    let result = load_csv(&path, &registry)?;

    println!("=== Load summary ===");
    println!("File: {}", path.display());
    println!("Duration: {:.3} s", result.duration_us as f64 / 1_000_000.0);
    println!("Rate groups: {}", result.rate_groups.len());
    for rg in &result.rate_groups {
        println!("  - {} @ {:.0} Hz, {} channels", rg.id, rg.nominal_rate_hz, rg.channel_ids().len());
    }
    println!();

    println!("=== Channels resolved ===");
    println!("{:<45} {:<30} {:>10}", "header (canonical id)", "display_name", "rate_hz");
    println!("{}", "-".repeat(90));
    for rg in &result.rate_groups {
        for id in rg.channel_ids() {
            let meta = rg.meta(id).unwrap();
            println!("{:<45} {:<30} {:>10}", id, meta.display_name, meta.sample_rate_hz as i32);
        }
    }
    println!();

    println!("=== Warnings ({}) ===", result.warnings.len());
    for w in &result.warnings {
        println!("  • {}", w);
    }

    // Focused report: did engine.tps and engine.aps both come through?
    println!();
    println!("=== Focus: TPS / APS resolution ===");
    let mut found_tps = false;
    let mut found_aps = false;
    for rg in &result.rate_groups {
        for id in rg.channel_ids() {
            if id == "engine.tps" { found_tps = true; }
            if id == "engine.aps" { found_aps = true; }
        }
    }
    println!("engine.tps resolved: {}", found_tps);
    println!("engine.aps resolved: {}", found_aps);

    Ok(())
}
