use anyhow::Result;
use clap::Args as ClapArgs;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// First NDJSON result file
    pub a: PathBuf,
    /// Second NDJSON result file
    pub b: PathBuf,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench compare: not yet implemented");
}
