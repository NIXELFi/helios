//! `helios-bench run` — execute one or more single-RPM simulations from study.toml.

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
    /// Override commit hash (default: read from `git rev-parse HEAD`)
    #[arg(long)]
    pub commit: Option<String>,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench run: not yet implemented");
}
