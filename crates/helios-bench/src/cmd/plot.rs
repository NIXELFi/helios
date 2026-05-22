use anyhow::Result;
use clap::Args as ClapArgs;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// NDJSON result file
    pub results: PathBuf,
    /// Output SVG path
    #[arg(long)]
    pub out: PathBuf,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench plot: not yet implemented");
}
