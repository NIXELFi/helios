use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "helios-bench", version, about = "Physics agent simulation CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run a single recorded simulation from study.toml
    Run(helios_bench::cmd::run::Args),
    /// Run a parameter sweep
    Sweep(helios_bench::cmd::sweep::Args),
    /// Validate an ndjson result file against physics invariants
    Validate(helios_bench::cmd::validate::Args),
    /// Compare two ndjson result files
    Compare(helios_bench::cmd::compare::Args),
    /// Plot a result file (SVG)
    Plot(helios_bench::cmd::plot::Args),
    /// Fingerprint the source tree for a study
    Fingerprint(helios_bench::cmd::fingerprint::Args),
    /// Read-only helpers over the .physics_locks/ ledger
    Locks(helios_bench::cmd::locks::Args),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Run(a) => helios_bench::cmd::run::execute(a),
        Cmd::Sweep(a) => helios_bench::cmd::sweep::execute(a),
        Cmd::Validate(a) => helios_bench::cmd::validate::execute(a),
        Cmd::Compare(a) => helios_bench::cmd::compare::execute(a),
        Cmd::Plot(a) => helios_bench::cmd::plot::execute(a),
        Cmd::Fingerprint(a) => helios_bench::cmd::fingerprint::execute(a),
        Cmd::Locks(a) => helios_bench::cmd::locks::execute(a),
    }
}
