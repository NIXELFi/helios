use anyhow::Result;
use clap::Args as ClapArgs;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to study.toml
    pub study: PathBuf,
    /// Suggest a file superset for fingerprinting
    #[arg(long)]
    pub suggest: bool,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench fingerprint: not yet implemented");
}
