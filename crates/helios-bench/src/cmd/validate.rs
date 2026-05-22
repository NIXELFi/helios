use anyhow::Result;
use clap::Args as ClapArgs;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to NDJSON result file
    pub results: PathBuf,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench validate: not yet implemented");
}
