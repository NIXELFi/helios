//! Load a recorded fsae-sim telemetry file through the real Helios CSV
//! pipeline and print what came out.
//!
//!   cargo run -p helios-csv --example probe_sim_run -- <telemetry.csv>

use helios_csv::{load_csv, ChannelRegistry};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = PathBuf::from(args.first().expect("usage: probe_sim_run <telemetry.csv>"));
    let reg_path = args.get(1).cloned().unwrap_or_else(|| "docs/channels.yaml".into());
    let registry = ChannelRegistry::from_path(&PathBuf::from(&reg_path)).expect("registry");
    let t0 = std::time::Instant::now();
    let r = load_csv(&path, &registry).expect("load");
    let took = t0.elapsed();

    println!("loaded in {:?}", took);
    println!("duration {:.3} s", r.duration_us as f64 / 1e6);
    println!("{} rate group(s)", r.rate_groups.len());
    for g in &r.rate_groups {
        println!("  {} : {} channels, {} rows, {:.1} Hz nominal",
                 g.id, g.channel_ids().len(), g.time_us().len(), g.nominal_rate_hz);
    }
    let unknown: Vec<&String> = r.warnings.iter().filter(|w| w.contains("unknown channel")).collect();
    println!("{} warning(s), {} unknown channel(s)", r.warnings.len(), unknown.len());
    for w in r.warnings.iter().take(12) { println!("  ! {w}"); }

    // Spot-check that a few channels resolved to the canonical ids and carry
    // their registry metadata rather than a synthesized default.
    for id in ["engine.rpm", "gps.lat", "imu.lat_g", "sim.slip_front_deg",
               "sim.track_s_m", "sim.util_rear", "sim.lap"] {
        let mut found = None;
        for g in &r.rate_groups {
            if let Some(m) = g.meta(id) { found = Some((g.id.clone(), m.clone())); break; }
        }
        match found {
            Some((grp, m)) => println!("  {:<22} {:<22} {:<7} group={:<12} src={} in {}",
                                       id, m.display_name, m.units, m.group, m.source, grp),
            None => println!("  {:<22} MISSING", id),
        }
    }
}
