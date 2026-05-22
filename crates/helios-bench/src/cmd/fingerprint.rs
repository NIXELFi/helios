//! `helios-bench fingerprint` — propose or compute source-tree fingerprints.
//!
//! Two modes:
//! - `--suggest --package <name>`: walks `cargo metadata --no-deps` to find
//!   the named workspace package, enumerates every `*.rs` file under its
//!   `src/` and `tests/` directories, and prints them as workspace-relative
//!   forward-slash paths, sorted. This is the orchestrator's "first guess"
//!   at the file list — humans / agents prune it down to the actual
//!   write-claim manifest.
//! - `--files <list-path>`: reads a newline-separated list of files,
//!   computes SHA-256 of each, and prints `<hex>  <path>` per line
//!   (mirroring the `sha256sum` format). Suitable for the
//!   `baseline_fingerprint` field on a `finding.md`.

use anyhow::{Context, Result};
use clap::Args as ClapArgs;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(ClapArgs)]
pub struct Args {
    /// Suggest mode: enumerate per-package `*.rs` under `src/` and `tests/`.
    #[arg(long)]
    pub suggest: bool,
    /// Workspace package to enumerate (e.g., `engine-sim`).
    #[arg(long)]
    pub package: Option<String>,
    /// Path to a newline-separated file list. Computes SHA-256 of each entry.
    #[arg(long)]
    pub files: Option<PathBuf>,
}

pub fn execute(args: Args) -> Result<()> {
    match (args.suggest, args.files.as_ref()) {
        (true, _) => {
            let pkg = args
                .package
                .as_deref()
                .context("--suggest requires --package <name>")?;
            suggest(pkg)
        }
        (false, Some(list)) => compute_hashes(list),
        (false, None) => {
            anyhow::bail!(
                "fingerprint: pick one mode — either `--suggest --package <name>` or `--files <list>`"
            )
        }
    }
}

fn suggest(pkg: &str) -> Result<()> {
    let meta = Command::new("cargo")
        .args(["metadata", "--format-version=1", "--no-deps"])
        .output()
        .context("invoke cargo metadata")?;
    if !meta.status.success() {
        anyhow::bail!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&meta.stderr)
        );
    }
    let v: serde_json::Value =
        serde_json::from_slice(&meta.stdout).context("parse cargo metadata output")?;
    let packages = v["packages"]
        .as_array()
        .context("`packages` array missing in cargo metadata")?;
    let p = packages
        .iter()
        .find(|p| p["name"] == pkg)
        .ok_or_else(|| anyhow::anyhow!("package `{pkg}` not found in workspace"))?;
    let manifest_path = p["manifest_path"]
        .as_str()
        .context("manifest_path missing on package")?;
    let workspace_root = v["workspace_root"]
        .as_str()
        .context("workspace_root missing on metadata")?;

    let manifest_dir = Path::new(manifest_path)
        .parent()
        .context("manifest_path has no parent")?
        .to_path_buf();
    let workspace_root = PathBuf::from(workspace_root);

    let mut out: Vec<String> = Vec::new();
    for sub in ["src", "tests"] {
        let d = manifest_dir.join(sub);
        if d.exists() {
            walk_rs(&d, &workspace_root, &mut out);
        }
    }
    out.sort();
    for f in &out {
        println!("{f}");
    }
    Ok(())
}

fn walk_rs(d: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(d) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_rs(&p, root, out);
            continue;
        }
        if p.extension().map(|x| x == "rs").unwrap_or(false) {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

fn compute_hashes(list: &Path) -> Result<()> {
    let body = std::fs::read_to_string(list)
        .with_context(|| format!("read file list {}", list.display()))?;
    for raw in body.lines() {
        let f = raw.trim();
        if f.is_empty() {
            continue;
        }
        let bytes = std::fs::read(f).with_context(|| format!("read {f}"))?;
        let mut h = Sha256::new();
        h.update(&bytes);
        let digest = h.finalize();
        println!("{:x}  {f}", digest);
    }
    Ok(())
}
