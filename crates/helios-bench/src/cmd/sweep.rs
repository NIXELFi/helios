use anyhow::Result;
use clap::Args as ClapArgs;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to study.toml
    pub study: PathBuf,
    /// Output NDJSON path
    #[arg(long)]
    pub out: PathBuf,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench sweep: not yet implemented");
}
