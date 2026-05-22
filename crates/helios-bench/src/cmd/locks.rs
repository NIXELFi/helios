//! `helios-bench locks <subcommand>` — read-only helpers over the
//! `.physics_locks/` ledger. plan-review-v1 #11: the `parse-manifest`
//! subcommand is what `.githooks/pre-commit` calls instead of jq or
//! python, so the hook has no system-tool dependency on Windows.

use crate::locks::Manifest;
use anyhow::{Context, Result};
use clap::{Args as ClapArgs, Subcommand};
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: LocksCmd,
}

#[derive(Subcommand)]
pub enum LocksCmd {
    /// Read a lock JSON and print each `files[]` entry on its own line.
    /// Exits non-zero if the file is missing or the JSON cannot be parsed.
    ParseManifest {
        /// Path to a `.physics_locks/NNNN-<slug>.lock` file.
        path: PathBuf,
    },
}

pub fn execute(args: Args) -> Result<()> {
    match args.cmd {
        LocksCmd::ParseManifest { path } => parse_manifest(&path),
    }
}

fn parse_manifest(path: &std::path::Path) -> Result<()> {
    if !path.exists() {
        anyhow::bail!("manifest not found: {}", path.display());
    }
    let manifest = Manifest::load(path)
        .with_context(|| format!("load manifest {}", path.display()))?;
    for f in &manifest.files {
        println!("{}", f);
    }
    Ok(())
}
