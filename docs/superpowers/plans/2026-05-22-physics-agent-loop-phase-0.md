# Physics Agent Loop — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 0 infrastructure that lets Claude agents autonomously design, run, and validate engine-sim physics investigations in isolated git worktrees, with bit-exact reproducibility and a pre-commit + doctor parity gate.

**Architecture:** A new `crates/helios-bench` Rust binary owns the simulation contract (`study.toml` in → NDJSON out). A new `physics_findings/` registry at the repo root holds investigations, references, and orchestration metadata. A `.physics_locks/` ledger with an `O_EXCL` orchestrator mutex and per-investigation write-claim manifests prevents concurrent corruption. A `.githooks/` directory holds the parity pre-commit hook activated via `core.hooksPath`. PowerShell + bash spawn/reap scripts handle worktree lifecycle. `.claude/agents/physics-*.md` defines the orchestrator/researcher/skeptic/implementer/doctor fleet. A `helios-mcp` server wraps the CLI for tighter agent integration. An end-to-end smoke test runs the full lifecycle on a trivial known-good finding.

**Tech Stack:** Rust (workspace already exists, `serde`/`serde_json`/`anyhow`/`thiserror`/`rayon` available), `toml` (new), `clap` (new), `sha2` (new), `petgraph` (new — for fingerprint dependency walking), `mcp-rust-sdk` (new), PowerShell + bash for worktree scripts, Git hooks via in-repo `.githooks/` + `core.hooksPath`.

**Spec:** [docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md](../specs/2026-05-22-physics-agent-loop-design.md). Read it first.

---

## File Structure

### New crates
- `crates/helios-bench/Cargo.toml` — binary crate
- `crates/helios-bench/src/main.rs` — clap CLI entrypoint, subcommand dispatch
- `crates/helios-bench/src/lib.rs` — re-exports (library surface for `helios-mcp` to call directly)
- `crates/helios-bench/src/study.rs` — `study.toml` schema (`[run]`, `[sweep]`, `[acceptance]`, `[environment]`)
- `crates/helios-bench/src/ndjson.rs` — NDJSON writer with required environment-block first line
- `crates/helios-bench/src/environment.rs` — capture target_triple, rustc_version, libm_source, rayon_threads
- `crates/helios-bench/src/cmd/run.rs` — `run` subcommand: load study.toml → SDM26Engine → NDJSON
- `crates/helios-bench/src/cmd/sweep.rs` — `sweep` subcommand: wraps `cfd_core::optimization::run_optimization_job`, required seed
- `crates/helios-bench/src/cmd/validate.rs` — `validate` subcommand: mass/energy/momentum/positivity/monotonicity per C9
- `crates/helios-bench/src/cmd/compare.rs` — `compare` subcommand: diff two NDJSON files, emit per-metric deltas
- `crates/helios-bench/src/cmd/plot.rs` — `plot` subcommand: SVG P-θ, P-V, power curve, BSFC
- `crates/helios-bench/src/cmd/fingerprint.rs` — `fingerprint --suggest` subcommand: walks `cargo build --build-plan`, proposes file superset
- `crates/helios-bench/tests/cli.rs` — end-to-end CLI invocation tests
- `crates/helios-mcp/Cargo.toml` — binary crate
- `crates/helios-mcp/src/main.rs` — MCP server entrypoint
- `crates/helios-mcp/src/handlers.rs` — `run_sim`, `submit_sweep`, `read_finding`, `list_findings`, `query_literature`, `validate_results` handlers

### Registry
- `physics_findings/README.md` — auto-generated status board (template)
- `physics_findings/ORCHESTRATOR.md` — orchestrator playbook
- `physics_findings/PARITY_FLAGS.toml` — enumerates opt-in flags + default-off values per C5
- `physics_findings/templates/finding.md.tmpl` — frontmatter + body skeleton
- `physics_findings/templates/study.toml.tmpl` — sections + comments
- `physics_findings/templates/literature.md.tmpl`
- `physics_findings/references/literature/heywood-combustion-ch9.md` — paraphrased excerpts (Wiebe, two-zone, MBT)
- `physics_findings/references/literature/heywood-heat-transfer-ch12.md` — Annand + Woschni
- `physics_findings/references/literature/heywood-friction-ch13.md` — Chen-Flynn FMEP decomposition
- `physics_findings/references/literature/heywood-valve-flow-ch6.md` — Cd(L/D) curves, choking
- `physics_findings/references/literature/woschni-1967.md` — original correlation paper paraphrase
- `physics_findings/references/literature/chen-flynn-1965.md` — friction correlation paraphrase
- `physics_findings/references/literature/engelman-1973.md` — acoustic tuning paraphrase
- `physics_findings/references/literature/lumley-engines-ch4.md` — turbulence + burn rate
- `physics_findings/references/literature/ferguson-kirkpatrick-ch5.md` — multi-zone combustion
- `physics_findings/references/literature/burcat-nasa7-coefficients.md` — NASA-7 polynomial table reference
- `physics_findings/references/dyno/cbr600rr-fsae-restricted.csv` — calibration data (existing, copy in)
- `physics_findings/references/dyno/cbr600rr-stock-unrestricted.csv` — calibration data (existing, copy in)
- `physics_findings/references/dyno/fsae-single-cylinder-ka100.csv` — second-engine reference (new, sourced from published FSAE paper)
- `physics_findings/references/dyno/README.md` — provenance + citations per dataset
- `physics_findings/_stale_queue.ndjson` — initially empty
- `physics_findings/.gitignore` — ignore `worktrees/` if it ends up nested

### Locks
- `.physics_locks/README.md` — format documentation
- `.physics_locks/_orchestrator.mutex.example` — example mutex file format

### Git hooks
- `.githooks/pre-commit` — bash script; enforces manifest + parity test + HELIOS_PHYSICS_AGENT marker
- `.githooks/pre-commit.ps1` — PowerShell equivalent (not used by git directly but referenced for Windows debugging)
- `.githooks/install.sh` — sets `core.hooksPath = .githooks` and makes hooks executable
- `.githooks/install.ps1` — PowerShell equivalent
- `.githooks/lib/parity_runner.sh` — shared parity-test invocation

### Worktree scripts
- `scripts/physics/spawn-worktree.ps1` — main Windows path: acquire mutex, check collisions, create worktree, set hooksPath, set HELIOS_PHYSICS_AGENT
- `scripts/physics/spawn-worktree.sh` — POSIX equivalent
- `scripts/physics/reap-worktree.ps1` — remove worktree, release lock, write merge metadata
- `scripts/physics/reap-worktree.sh` — POSIX equivalent
- `scripts/physics/process-amendments.ps1` — orchestrator polls `pending_amend.json` across active worktrees
- `scripts/physics/process-amendments.sh` — POSIX equivalent
- `scripts/physics/process-stale-queue.ps1` — drain `_stale_queue.ndjson`, reopen STALE findings
- `scripts/physics/process-stale-queue.sh` — POSIX equivalent
- `scripts/physics/README.md` — usage docs

### Worktrees
- `worktrees/.gitkeep` — empty file to track the dir (worktree subdirs are `.gitignore`'d)
- Root `.gitignore` updated with `worktrees/*` and `!worktrees/.gitkeep`

### Agent definitions
- `.claude/agents/physics-orchestrator.md`
- `.claude/agents/physics-researcher.md`
- `.claude/agents/physics-skeptic.md`
- `.claude/agents/physics-implementer.md`
- `.claude/agents/physics-doctor.md`

### Workspace updates
- `Cargo.toml` (workspace) — add `crates/helios-bench`, `crates/helios-mcp`; add workspace deps for `toml`, `clap`, `sha2`, `petgraph`, MCP SDK
- `crates/helios-bench/Cargo.toml` — depends on `engine-sim`, `cfd-core`, `serde`, `serde_json`, `toml`, `clap`, `sha2`, `anyhow`, `thiserror`, `rayon`
- `crates/helios-mcp/Cargo.toml` — depends on `helios-bench` (lib), `serde`, `serde_json`, MCP SDK, `tokio`

### Other
- `.gitignore` — append `worktrees/*` (except `.gitkeep`), `.physics_locks/_orchestrator.mutex` (transient), `crates/helios-bench/target/`
- `crates/cfd-core/tests/regressions/.gitkeep` — placeholder for `FIXED`-finding regression tests

---

## Task 1: Workspace + helios-bench skeleton

**Files:**
- Create: `crates/helios-bench/Cargo.toml`
- Create: `crates/helios-bench/src/main.rs`
- Create: `crates/helios-bench/src/lib.rs`
- Create: `crates/helios-bench/tests/cli.rs`
- Modify: `Cargo.toml` (workspace root)

- [ ] **Step 1.1: Write the failing CLI smoke test**

Create `crates/helios-bench/tests/cli.rs`:

```rust
//! Top-level CLI smoke. Most subcommands have their own integration tests.

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

#[test]
fn version_prints() {
    let out = bin().arg("--version").output().expect("spawn");
    assert!(out.status.success(), "--version failed: {:?}", out);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("helios-bench"), "missing name: {stdout}");
}

#[test]
fn help_lists_subcommands() {
    let out = bin().arg("--help").output().expect("spawn");
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    for sc in ["run", "sweep", "validate", "compare", "plot", "fingerprint"] {
        assert!(stdout.contains(sc), "help missing subcommand `{sc}`: {stdout}");
    }
}
```

- [ ] **Step 1.2: Add to workspace + create skeleton**

Append to `Cargo.toml` (workspace, line ~13):

```toml
"crates/helios-bench",
```

Append to `[workspace.dependencies]` (workspace, line ~36):

```toml
toml = "0.8"
clap = { version = "4", features = ["derive"] }
sha2 = "0.10"
```

Create `crates/helios-bench/Cargo.toml`:

```toml
[package]
name = "helios-bench"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "Physics agent loop: deterministic simulation CLI over engine-sim + cfd-core."

[[bin]]
name = "helios-bench"
path = "src/main.rs"

[lib]
name = "helios_bench"
path = "src/lib.rs"

[dependencies]
engine-sim = { path = "../engine-sim" }
cfd-core = { path = "../cfd-core" }
serde = { workspace = true }
serde_json = { workspace = true }
toml = { workspace = true }
clap = { workspace = true }
sha2 = { workspace = true }
anyhow = { workspace = true }
thiserror = { workspace = true }
rayon = { workspace = true }
```

Create `crates/helios-bench/src/lib.rs`:

```rust
//! Helios bench: the reproducibility unit for physics agent investigations.
//!
//! CLI is canonical (per spec C11). This lib surface lets `helios-mcp`
//! call the same code paths without shelling out.

pub mod study;
pub mod environment;
pub mod ndjson;
pub mod cmd;
```

Create `crates/helios-bench/src/main.rs`:

```rust
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
    }
}
```

Create stub `crates/helios-bench/src/cmd/mod.rs`:

```rust
pub mod run;
pub mod sweep;
pub mod validate;
pub mod compare;
pub mod plot;
pub mod fingerprint;
```

Create stubs for each subcommand (each one identical structure — example for `run.rs`):

```rust
use anyhow::Result;
use clap::Args as ClapArgs;

#[derive(ClapArgs)]
pub struct Args {
    /// Path to study.toml
    pub study: std::path::PathBuf,
}

pub fn execute(_args: Args) -> Result<()> {
    anyhow::bail!("helios-bench run: not yet implemented");
}
```

Create stubs for `study.rs`, `environment.rs`, `ndjson.rs` as empty modules with `//! TODO` doc comments.

- [ ] **Step 1.3: Build**

Run: `cargo build -p helios-bench`
Expected: PASS (warnings about unused are fine; errors are not)

- [ ] **Step 1.4: Run smoke test**

Run: `cargo test -p helios-bench --test cli`
Expected: PASS — `version_prints` succeeds, `help_lists_subcommands` succeeds.

- [ ] **Step 1.5: Commit**

```bash
git add Cargo.toml crates/helios-bench/
git commit -m "feat(helios-bench): crate skeleton + CLI smoke test

Six subcommands as stubs (run/sweep/validate/compare/plot/fingerprint).
Each currently bails. CLI parses, version prints, help lists all six."
```

---

## Task 2: study.toml schema + parser

**Files:**
- Modify: `crates/helios-bench/src/study.rs`
- Create: `crates/helios-bench/tests/study_parse.rs`

- [ ] **Step 2.1: Write failing schema tests**

Create `crates/helios-bench/tests/study_parse.rs`:

```rust
use helios_bench::study::*;

#[test]
fn parses_minimal_recorded_run() {
    let s = r#"
        [run]
        config = "engine_matrix_sdm26_baseline.json"
        rpm = [9000, 12000]
        cycles = 30
        recorded = true
        seed = 42

        [environment]
        target_triple = "x86_64-pc-windows-msvc"
        rustc_version = "1.78.0"
        rayon_threads = 1
        libm_source = "rust-builtin"

        [[acceptance]]
        metric = "peak_power_kW"
        target = 50.0
        tolerance = "5%"
        citation = "two_zone_results.md"
    "#;
    let study: Study = toml::from_str(s).expect("parse");
    assert_eq!(study.run.cycles, 30);
    assert_eq!(study.run.rpm, vec![9000, 12000]);
    assert!(study.run.recorded);
    assert_eq!(study.run.seed, 42);
    assert_eq!(study.environment.rayon_threads, 1);
    assert_eq!(study.acceptance.len(), 1);
    assert_eq!(study.acceptance[0].metric, "peak_power_kW");
}

#[test]
fn rejects_recorded_run_without_seed() {
    let s = r#"
        [run]
        config = "x.json"
        rpm = [9000]
        cycles = 30
        recorded = true

        [environment]
        target_triple = "x"
        rustc_version = "x"
        rayon_threads = 1
        libm_source = "rust-builtin"
    "#;
    let r: Result<Study, _> = toml::from_str(s);
    assert!(r.is_err(), "recorded run with no seed should fail: {:?}", r);
}

#[test]
fn rejects_recorded_run_with_threads_gt_1() {
    let s = r#"
        [run]
        config = "x.json"
        rpm = [9000]
        cycles = 30
        recorded = true
        seed = 7

        [environment]
        target_triple = "x"
        rustc_version = "x"
        rayon_threads = 4
        libm_source = "rust-builtin"
    "#;
    let parsed: Study = toml::from_str(s).expect("parse");
    let v = parsed.validate();
    assert!(v.is_err(), "recorded run with rayon_threads=4 should fail validate(): {:?}", v);
}

#[test]
fn exploratory_run_allows_missing_seed_and_threads_gt_1() {
    let s = r#"
        [run]
        config = "x.json"
        rpm = [9000]
        cycles = 30
        recorded = false

        [environment]
        target_triple = "x"
        rustc_version = "x"
        rayon_threads = 8
        libm_source = "rust-builtin"
    "#;
    let parsed: Study = toml::from_str(s).expect("parse");
    parsed.validate().expect("exploratory run should pass");
}

#[test]
fn parses_sweep_block() {
    let s = r#"
        [run]
        config = "x.json"
        rpm = [9000]
        cycles = 30
        recorded = true
        seed = 7

        [environment]
        target_triple = "x"
        rustc_version = "x"
        rayon_threads = 1
        libm_source = "rust-builtin"

        [sweep]
        sampler = "lhs"
        n_trials = 32
        parameters = [
            { name = "woschni_c1", min = 1.8, max = 2.6 },
            { name = "woschni_c2", min = 0.0, max = 0.005 },
        ]
    "#;
    let parsed: Study = toml::from_str(s).expect("parse");
    let sweep = parsed.sweep.expect("sweep present");
    assert_eq!(sweep.n_trials, 32);
    assert_eq!(sweep.parameters.len(), 2);
}
```

- [ ] **Step 2.2: Run tests, see them fail**

Run: `cargo test -p helios-bench --test study_parse`
Expected: FAIL — `study::Study` does not exist.

- [ ] **Step 2.3: Implement `study.rs`**

Replace `crates/helios-bench/src/study.rs`:

```rust
//! `study.toml` schema — the reproducibility unit.
//!
//! Required sections: [run], [environment].
//! Optional: [sweep], [[acceptance]].
//!
//! Validation rules (see spec C4 + C6):
//!   - recorded=true REQUIRES seed
//!   - recorded=true REQUIRES rayon_threads == 1
//!   - every metric in [[acceptance]] must have a citation

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
pub struct Study {
    pub run: Run,
    pub environment: Environment,
    #[serde(default)]
    pub sweep: Option<Sweep>,
    #[serde(default)]
    pub acceptance: Vec<Acceptance>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Run {
    pub config: String,
    pub rpm: Vec<u32>,
    pub cycles: u32,
    /// If true, this run is reproducibility-recorded — seed required, rayon_threads must be 1.
    pub recorded: bool,
    /// Required when recorded=true. Required field — serde refuses missing key.
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Environment {
    pub target_triple: String,
    pub rustc_version: String,
    pub rayon_threads: u32,
    pub libm_source: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Sweep {
    pub sampler: String,
    pub n_trials: u32,
    pub parameters: Vec<SweepParam>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SweepParam {
    pub name: String,
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Acceptance {
    pub metric: String,
    pub target: f64,
    /// Tolerance: "5%" or "±5%" or "0.95x" (one-sided). Parsed at validate time.
    pub tolerance: String,
    pub citation: String,
}

impl Study {
    /// Cross-field validation. Serde catches missing keys; this catches semantic errors.
    pub fn validate(&self) -> Result<(), String> {
        if self.run.recorded {
            if self.run.seed.is_none() {
                return Err("recorded=true requires `seed`".into());
            }
            if self.environment.rayon_threads != 1 {
                return Err(format!(
                    "recorded=true requires rayon_threads=1, got {}",
                    self.environment.rayon_threads
                ));
            }
        }
        for a in &self.acceptance {
            if a.citation.trim().is_empty() {
                return Err(format!("acceptance metric {} has empty citation", a.metric));
            }
        }
        Ok(())
    }
}
```

Note: the "recorded without seed" test relies on `serde(default)` letting it parse but then `validate()` rejecting. Adjust the test if needed — the version above expects toml::from_str to succeed and then validate() to fail. Let me restate the test expectation: the third test (`rejects_recorded_run_without_seed`) should actually be `parses_but_validate_rejects_recorded_without_seed`. Update the test in step 2.1 accordingly:

Replace test body in 2.1:

```rust
#[test]
fn rejects_recorded_run_without_seed() {
    // ... toml from above ...
    let parsed: Study = toml::from_str(s).expect("parse");
    let v = parsed.validate();
    assert!(v.is_err(), "recorded run with no seed should fail validate(): {:?}", v);
}
```

- [ ] **Step 2.4: Run tests**

Run: `cargo test -p helios-bench --test study_parse`
Expected: ALL PASS.

- [ ] **Step 2.5: Commit**

```bash
git add crates/helios-bench/src/study.rs crates/helios-bench/tests/study_parse.rs
git commit -m "feat(helios-bench): study.toml schema with C4 + C6 validation"
```

---

## Task 3: NDJSON writer with environment-block first line

**Files:**
- Modify: `crates/helios-bench/src/ndjson.rs`
- Modify: `crates/helios-bench/src/environment.rs`
- Create: `crates/helios-bench/tests/ndjson_envblock.rs`

- [ ] **Step 3.1: Write failing test**

Create `crates/helios-bench/tests/ndjson_envblock.rs`:

```rust
use helios_bench::ndjson::ResultWriter;
use helios_bench::study::Environment;
use serde_json::json;
use tempfile::NamedTempFile;
use std::io::{BufRead, BufReader};
use std::fs::File;

fn env() -> Environment {
    Environment {
        target_triple: "x86_64-pc-windows-msvc".into(),
        rustc_version: "1.78.0".into(),
        rayon_threads: 1,
        libm_source: "rust-builtin".into(),
    }
}

#[test]
fn first_line_is_environment() {
    let tmp = NamedTempFile::new().unwrap();
    let mut w = ResultWriter::create(tmp.path(), &env(), Some(7), "abc123").unwrap();
    w.write(&json!({"trial": 1, "imep_bar": 9.5})).unwrap();
    w.finish().unwrap();

    let r = BufReader::new(File::open(tmp.path()).unwrap());
    let lines: Vec<String> = r.lines().filter_map(|l| l.ok()).collect();
    assert_eq!(lines.len(), 2);
    let env_line: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(env_line["kind"], "environment");
    assert_eq!(env_line["env"]["target_triple"], "x86_64-pc-windows-msvc");
    assert_eq!(env_line["seed"], 7);
    assert_eq!(env_line["commit_hash"], "abc123");

    let trial: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
    assert_eq!(trial["trial"], 1);
}

#[test]
fn finish_required_before_drop() {
    // ResultWriter must require explicit finish() to flush + close;
    // dropping without finish should not produce a usable file.
    let tmp = NamedTempFile::new().unwrap();
    {
        let mut w = ResultWriter::create(tmp.path(), &env(), Some(7), "abc").unwrap();
        w.write(&json!({"trial": 1})).unwrap();
        // dropped without finish
    }
    // File exists but has at least the env line (we flush on each write to be safe).
    let r = BufReader::new(File::open(tmp.path()).unwrap());
    let lines: Vec<String> = r.lines().filter_map(|l| l.ok()).collect();
    assert!(!lines.is_empty(), "env block at minimum should be present");
}
```

- [ ] **Step 3.2: Add `tempfile` to dev-deps**

Append to `crates/helios-bench/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3.3: Run test, see it fail**

Run: `cargo test -p helios-bench --test ndjson_envblock`
Expected: FAIL — `ResultWriter` not defined.

- [ ] **Step 3.4: Implement `environment.rs`**

```rust
//! Environment capture for reproducibility (spec C4).
//!
//! Detects `target_triple`, `rustc_version`, and `libm_source` at build /
//! runtime. `rayon_threads` is supplied by the caller (from study.toml or CLI).

use crate::study::Environment;

/// Build-time target triple (set by build.rs).
pub fn target_triple() -> &'static str {
    env!("HELIOS_BENCH_TARGET_TRIPLE")
}

/// rustc version (set by build.rs).
pub fn rustc_version() -> &'static str {
    env!("HELIOS_BENCH_RUSTC_VERSION")
}

/// On Windows MSVC + glibc + musl this returns "system";
/// when compiled with `-Cembed-bitcode=yes -Clinker-plugin-lto=on` against
/// libm.rs it returns "rust-builtin". Heuristic only — record what build.rs detected.
pub fn libm_source() -> &'static str {
    env!("HELIOS_BENCH_LIBM_SOURCE")
}

/// Capture the current environment as a study Environment block.
pub fn capture(rayon_threads: u32) -> Environment {
    Environment {
        target_triple: target_triple().into(),
        rustc_version: rustc_version().into(),
        rayon_threads,
        libm_source: libm_source().into(),
    }
}

/// Compare two environments. Returns Ok if compatible (any difference is a warning
/// for the doctor, not a hard fail — except target_triple, which IS hard).
pub fn check_compatible(actual: &Environment, recorded: &Environment) -> Result<Vec<String>, String> {
    if actual.target_triple != recorded.target_triple {
        return Err(format!(
            "target_triple mismatch: actual {} vs recorded {}",
            actual.target_triple, recorded.target_triple
        ));
    }
    let mut warnings = Vec::new();
    if actual.rustc_version != recorded.rustc_version {
        warnings.push(format!(
            "rustc_version differs: actual {} vs recorded {}",
            actual.rustc_version, recorded.rustc_version
        ));
    }
    if actual.libm_source != recorded.libm_source {
        warnings.push(format!(
            "libm_source differs: actual {} vs recorded {}",
            actual.libm_source, recorded.libm_source
        ));
    }
    Ok(warnings)
}
```

Create `crates/helios-bench/build.rs`:

```rust
use std::process::Command;

fn main() {
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=HELIOS_BENCH_TARGET_TRIPLE={triple}");

    let rustc_out = Command::new("rustc")
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=HELIOS_BENCH_RUSTC_VERSION={rustc_out}");

    let libm = if triple.contains("windows-msvc") {
        "system"
    } else if triple.contains("linux-gnu") {
        "system-glibc"
    } else if triple.contains("musl") {
        "musl"
    } else {
        "unknown"
    };
    println!("cargo:rustc-env=HELIOS_BENCH_LIBM_SOURCE={libm}");

    println!("cargo:rerun-if-changed=build.rs");
}
```

- [ ] **Step 3.5: Implement `ndjson.rs`**

```rust
//! NDJSON writer with required environment-block first line (spec C4).

use crate::study::Environment;
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

pub struct ResultWriter {
    inner: BufWriter<File>,
    finished: bool,
}

impl ResultWriter {
    /// Create a new NDJSON result file. Writes the environment block as line 1.
    pub fn create(path: &Path, env: &Environment, seed: Option<u64>, commit_hash: &str) -> Result<Self> {
        let f = File::create(path).with_context(|| format!("create {}", path.display()))?;
        let mut inner = BufWriter::new(f);
        let env_line = json!({
            "kind": "environment",
            "env": env,
            "seed": seed,
            "commit_hash": commit_hash,
        });
        writeln!(inner, "{}", serde_json::to_string(&env_line)?)?;
        inner.flush()?;
        Ok(Self { inner, finished: false })
    }

    pub fn write<T: Serialize>(&mut self, value: &T) -> Result<()> {
        writeln!(self.inner, "{}", serde_json::to_string(value)?)?;
        self.inner.flush()?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        self.inner.flush()?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for ResultWriter {
    fn drop(&mut self) {
        let _ = self.inner.flush();
    }
}
```

- [ ] **Step 3.6: Run tests**

Run: `cargo test -p helios-bench --test ndjson_envblock`
Expected: PASS.

- [ ] **Step 3.7: Commit**

```bash
git add crates/helios-bench/src/ndjson.rs crates/helios-bench/src/environment.rs crates/helios-bench/build.rs crates/helios-bench/tests/ndjson_envblock.rs crates/helios-bench/Cargo.toml
git commit -m "feat(helios-bench): NDJSON writer + environment capture"
```

---

## Task 4: helios-bench run subcommand — execute SDM26Engine deterministically

**Files:**
- Modify: `crates/helios-bench/src/cmd/run.rs`
- Create: `crates/helios-bench/tests/run_smoke.rs`

- [ ] **Step 4.1: Write failing integration test**

Create `crates/helios-bench/tests/run_smoke.rs`:

```rust
//! Smoke: helios-bench run on a real engine_matrix_sdm26_baseline config
//! produces a result NDJSON whose first line is the environment block
//! and subsequent lines contain known fields (imep_bar, brake_power_kW, etc.).

use std::process::Command;
use tempfile::tempdir;
use std::io::Write;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_helios-bench"))
}

#[test]
fn run_produces_ndjson_with_env_first_line() {
    let dir = tempdir().unwrap();
    let study_path = dir.path().join("study.toml");
    let out_path = dir.path().join("results.ndjson");

    let cfg = std::fs::canonicalize(
        "../engine-sim/python_ref/golden_capture/configs/engine_matrix_sdm26_baseline.json"
    ).expect("baseline config exists");

    let toml_text = format!(
        r#"
[run]
config = "{cfg}"
rpm = [9000]
cycles = 30
recorded = true
seed = 1

[environment]
target_triple = "{}"
rustc_version = "any"
rayon_threads = 1
libm_source = "any"
"#,
        helios_bench::environment::target_triple(),
        cfg = cfg.display().to_string().replace('\\', "/")
    );
    std::fs::write(&study_path, toml_text).unwrap();

    let out = bin()
        .args(["run", study_path.to_str().unwrap(), "--out", out_path.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert!(out.status.success(), "run failed: stderr={}", String::from_utf8_lossy(&out.stderr));

    let body = std::fs::read_to_string(&out_path).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert!(lines.len() >= 2, "expected env line + at least one trial; got {}", lines.len());
    let env: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(env["kind"], "environment");
    let trial: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert!(trial["imep_bar"].is_number(), "trial missing imep_bar: {trial}");
    assert!(trial["brake_power_kW"].is_number(), "trial missing brake_power_kW: {trial}");
    assert!(trial["rpm"].is_number(), "trial missing rpm: {trial}");
}
```

- [ ] **Step 4.2: Run, see it fail**

Run: `cargo test -p helios-bench --test run_smoke -- --nocapture`
Expected: FAIL — `helios-bench run: not yet implemented`.

- [ ] **Step 4.3: Implement `cmd/run.rs`**

```rust
//! `helios-bench run` — execute one or more single-RPM simulations from study.toml.

use crate::study::Study;
use crate::environment::capture;
use crate::ndjson::ResultWriter;
use anyhow::{Context, Result, bail};
use clap::Args as ClapArgs;
use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::SDM26Engine;
use serde_json::json;
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

pub fn execute(args: Args) -> Result<()> {
    let txt = std::fs::read_to_string(&args.study)
        .with_context(|| format!("read {}", args.study.display()))?;
    let study: Study = toml::from_str(&txt).context("parse study.toml")?;
    study.validate().map_err(|e| anyhow::anyhow!("validate: {e}"))?;

    // Recorded runs are pinned to single-thread to make NDJSON line-order deterministic
    // (per spec C4). Exploratory runs may parallelize.
    if study.run.recorded {
        std::env::set_var("RAYON_NUM_THREADS", "1");
    }

    let commit = match args.commit.clone() {
        Some(c) => c,
        None => current_commit_hash().unwrap_or_else(|_| "unknown".into()),
    };

    let env = capture(study.environment.rayon_threads);
    let mut w = ResultWriter::create(&args.out, &env, study.run.seed, &commit)?;

    let cfg = load_v1_json(&study.run.config)
        .with_context(|| format!("load engine config {}", study.run.config))?;
    let mut engine = SDM26Engine::new(cfg)?;

    for &rpm in &study.run.rpm {
        let stats = engine.run_single_rpm(rpm, study.run.cycles, None)
            .with_context(|| format!("run rpm={rpm}"))?;
        let row = json!({
            "kind": "trial",
            "rpm": rpm,
            "cycles": study.run.cycles,
            "imep_bar": stats.imep_bar,
            "bmep_bar": stats.bmep_bar,
            "fmep_bar": stats.fmep_bar,
            "ve_atm": stats.ve_atm,
            "brake_power_kW": stats.brake_power_k_w,
            "brake_torque_Nm": stats.brake_torque_nm,
            "indicated_power_kW": stats.indicated_power_k_w,
            "egt_mean_K": stats.egt_mean,
            "mass_drift_kg": stats.mass_drift,
            "mass_total_kg": stats.mass_total,
            "nonconservation": stats.nonconservation,
            "intake_mass_per_cycle_g": stats.intake_mass_per_cycle_g,
            "f_residual": stats.f_residual,
        });
        w.write(&row)?;
    }

    w.finish()?;
    Ok(())
}

fn current_commit_hash() -> Result<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()?;
    if !out.status.success() {
        bail!("git rev-parse HEAD failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
```

Note: the `engine_sim::model::sdm26::SDM26Engine::run_single_rpm` signature should match what's in [crates/engine-sim/src/model/sdm26.rs](crates/engine-sim/src/model/sdm26.rs). Adjust the call shape if the actual signature differs — the goal is one stats struct per RPM.

- [ ] **Step 4.4: Build**

Run: `cargo build -p helios-bench`
Expected: PASS. If `run_single_rpm` returns a different shape, adapt the destructuring.

- [ ] **Step 4.5: Run the smoke test**

Run: `cargo test -p helios-bench --test run_smoke -- --nocapture`
Expected: PASS. The NDJSON file has 1 env line + 1 trial line; `imep_bar`, `brake_power_kW`, `rpm` all present.

- [ ] **Step 4.6: Commit**

```bash
git add crates/helios-bench/src/cmd/run.rs crates/helios-bench/tests/run_smoke.rs
git commit -m "feat(helios-bench): run subcommand executes single-RPM sims to NDJSON"
```

---

## Task 5: PARITY_FLAGS.toml + physics_findings scaffold + templates

**Files:**
- Create: `physics_findings/PARITY_FLAGS.toml`
- Create: `physics_findings/README.md`
- Create: `physics_findings/ORCHESTRATOR.md`
- Create: `physics_findings/templates/finding.md.tmpl`
- Create: `physics_findings/templates/study.toml.tmpl`
- Create: `physics_findings/templates/literature.md.tmpl`
- Create: `physics_findings/_stale_queue.ndjson`
- Create: `physics_findings/.gitignore`
- Create: `crates/cfd-core/tests/regressions/.gitkeep`

- [ ] **Step 5.1: Create PARITY_FLAGS.toml**

```toml
# Opt-in physics flags that MUST default to false / their parity-preserving value.
# The pre-commit hook (.githooks/pre-commit) runs parity tests with all flags
# at the values listed here. Adding a new flag REQUIRES adding it here too.

[flags]
afr_eta_enabled = false
two_zone_enabled = false
intake_lift_flat_top_ramp = 0.0
exhaust_lift_flat_top_ramp = 0.0
tumble_burn_factor = 0.0
# fmep coefficients default to legacy (parity) values; documented for clarity:
fmep_a = 0.5
fmep_b = 0.1
fmep_c = 0.003
# Inflow loss coefficient on stagnation junction: parity = 0
inflow_loss_coef = 0.0
```

- [ ] **Step 5.2: Create README + ORCHESTRATOR templates**

`physics_findings/README.md`:

```markdown
# Physics Findings Registry

Auto-generated. Do not edit by hand. Re-run the orchestrator status-board step to refresh.

## Status Board

| ID | Topic | Status | Spawned By | Opened | Closed |
|----|-------|--------|------------|--------|--------|
| _(none yet)_ |  |  |  |  |  |

## Status legend

- **INVESTIGATING** — researcher actively working
- **FIX-IN-PROGRESS** — implementer landing a fix
- **VALIDATED** — finding matches literature within `[acceptance]` band
- **FIXED** — fix landed + regression test passes
- **CEILING-LIMIT** — beyond solver-class capability
- **LITERATURE-AMBIGUOUS** — sources disagree
- **SOLVER-CHANGE-REQUIRED** — needs solver-core change (out-of-scope per spec §2)
- **ABANDONED** — pursued but discontinued
- **STALE** — terminal status auto-revoked by doctor; queued for re-validation
```

`physics_findings/ORCHESTRATOR.md`:

```markdown
# Orchestrator Playbook

You are the `physics-orchestrator` agent. Your main checkout is `C:\Users\nmurray\Documents\Helios`.

## Each dispatch cycle

1. **Process pending amendments** — for each `worktrees/agent-*/pending_amend.json`:
   - Acquire `.physics_locks/_orchestrator.mutex` (O_EXCL create)
   - Run collision check against all other live locks
   - On no-collision: rewrite `.physics_locks/NNNN-slug.lock`, commit, delete `pending_amend.json`
   - On collision: write `pending_amend.rejected.json` with the colliding lock's id

2. **Drain stale queue** — read and truncate `physics_findings/_stale_queue.ndjson`; for each event, flip the named finding's status to INVESTIGATING.

3. **Pick next finding** — priority order:
   - Phase 1 seeded list first (see spec §5 Phase 1)
   - Then any INVESTIGATING / STALE
   - Then proposed new investigations from researcher backlogs (`physics_findings/_proposals.ndjson`)

4. **Draft `study.toml` skeleton** — copy from `templates/study.toml.tmpl`. Fill in `[run]` config + RPM + cycles. Draft `[acceptance]` based on the topic's literature. Fill `[environment]` from `helios-bench --env-default` (target_triple, rustc_version, threads=1, libm_source).

5. **Declare write-claim manifest** — list every source file the agent may modify. Be conservative — researchers can amend if needed but every amendment costs a round trip.

6. **Spawn worktree** — run `scripts/physics/spawn-worktree.ps1 -id NNNN -slug ...`. The script acquires the mutex, checks collisions, creates the worktree, sets `core.hooksPath`, sets `HELIOS_PHYSICS_AGENT=1`, builds helios-bench inside the worktree.

7. **Dispatch researcher subagent** with the `physics-researcher` definition + the `study.toml` draft + the worktree path. Wait for completion.

8. **Dispatch skeptic for pre-run review** — skeptic reads `study.toml` `[acceptance]` block + literature; ACKs or CHALLENGEs.

9. **Dispatch researcher's actual run** — researcher runs `helios-bench run` / `sweep`, validates results, drafts `finding.md`.

10. **Dispatch skeptic for post-run review** — read-only worktree access. ACK or CHALLENGE.

11. **Verdict branch** (see spec §4.5 step 5):
    - VALIDATED → commit (pre-commit hook gates) → doctor sweep → merge → reap worktree → release lock
    - NEEDS-FIX → dispatch implementer → researcher re-runs → skeptic re-reviews (round counter ++) → repeat or terminal
    - CEILING-LIMIT / SOLVER-CHANGE-REQUIRED / LITERATURE-AMBIGUOUS / ABANDONED → metadata-only merge → reap → release

12. **Refresh status board** — rewrite `physics_findings/README.md` from current registry state.

## Concurrency budget

Default cap: 4 active worktrees. Adjust by editing this file (look for `concurrency_budget`).

`concurrency_budget = 4`

## Phase 1 priority queue

(see spec §5 Phase 1 for the seeded list)
```

- [ ] **Step 5.3: Create templates**

`physics_findings/templates/finding.md.tmpl`:

```markdown
---
id: NNNN
slug: <kebab-case>
status: INVESTIGATING
topic: <one-line topic>
hypothesis: <one-paragraph hypothesis>
opened: YYYY-MM-DD
closed: ~
owner: physics-researcher
spawned_by: manual  # or cron
commit_hash: ~
baseline_fingerprint: ~
revalidation_count: 0
acceptance_approved_at: ~
---

## Hypothesis

<expand from frontmatter>

## Study design

See `study.toml`.

## Literature

See `literature.md`.

## Results

<filled by researcher>

## Comparison vs literature

<filled by researcher>

## Conclusion

<filled by researcher; verdict + status transition>

## Skeptic review

### Pre-run (acceptance band)

- Reviewer: physics-skeptic
- Verdict: ACK | CHALLENGE
- Notes:

### Post-run (conclusion)

- Reviewer: physics-skeptic
- Verdict: ACK | CHALLENGE
- Notes:

## Reproducibility

```powershell
git checkout <commit_hash>
helios-bench run physics_findings/NNNN-slug/study.toml --out /tmp/r.ndjson
helios-bench compare /tmp/r.ndjson physics_findings/NNNN-slug/results.ndjson
```

## Revalidations

_(grows on STALE re-open)_
```

`physics_findings/templates/study.toml.tmpl`:

```toml
# study.toml — reproducibility unit (spec C4)
# Required: [run], [environment]. Optional: [sweep], [[acceptance]].

[run]
config = "physics_findings/references/dyno/engine_matrix_sdm26_baseline.json"  # adjust per finding
rpm = [6000, 9000, 12000]
cycles = 30
recorded = true
seed = 42  # REQUIRED when recorded=true

[environment]
target_triple = ""    # filled by orchestrator
rustc_version = ""    # filled by orchestrator
rayon_threads = 1     # MUST be 1 when recorded=true
libm_source = ""      # filled by orchestrator

# [sweep] optional — only present if running a parameter sweep
# [sweep]
# sampler = "lhs"
# n_trials = 32
# parameters = [
#   { name = "woschni_c1", min = 1.8, max = 2.6 },
# ]

[[acceptance]]
metric = "peak_power_kW"
target = 50.0
tolerance = "±5%"
citation = "Heywood 2018 Tab 5.1 + CBR600 dyno"

# Add as many [[acceptance]] blocks as the finding needs.
```

`physics_findings/templates/literature.md.tmpl`:

```markdown
# Literature for finding NNNN

## Citations

- Heywood, J.B. *Internal Combustion Engine Fundamentals*, 2nd ed., 2018. ISBN 9781260116106.
  - Section X.Y: <equation or claim being referenced>
- ...

## Equations under test

Equation 1 (Woschni 1967 eq. 4):
```
h_c = a · B^(-0.2) · p^0.8 · T^(-0.53) · w^0.8
```

## Expected ranges (from literature)

- `peak_power_kW`: 41–52 (CBR600RR @ 9k–13k RPM, FSAE-restricted, multiple sources)
- `bsfc_g_per_kWh`: 270–320 (Heywood Tab 5.2)
- ...
```

- [ ] **Step 5.4: Other scaffolding files**

Create `physics_findings/_stale_queue.ndjson` as an empty file.

Create `physics_findings/.gitignore`:

```
# Per-finding artifacts that are large are kept; intermediates aren't.
*/raw_traces/
```

Create `crates/cfd-core/tests/regressions/.gitkeep` (empty file).

- [ ] **Step 5.5: Verify scaffold loads**

Run: `cargo build` (workspace) — confirms `.gitkeep` etc. didn't break anything.
Expected: PASS (no changes to Rust code).

Read `physics_findings/PARITY_FLAGS.toml` with a quick TOML parse to confirm valid syntax:

```powershell
cargo run --quiet -p helios-bench -- --version
```

(Doesn't parse the file but confirms the build still works.)

- [ ] **Step 5.6: Commit**

```bash
git add physics_findings/ crates/cfd-core/tests/regressions/
git commit -m "feat(physics-findings): registry scaffold + templates + parity flags"
```

---

## Task 6: Reference literature corpus — initial 10 paraphrases

**Files:**
- Create 10 markdown files under `physics_findings/references/literature/`

This task is bulk-content. Each file paraphrases ~5–10 key equations from the source, lists the constants the engine-sim solver uses against the published values, and notes any disagreements between sources.

- [ ] **Step 6.1: Heywood Ch 9 (combustion)**

Create `physics_findings/references/literature/heywood-combustion-ch9.md` with:
- Wiebe function form and shape parameters (`m`, `a`) — Heywood eq. 9.65, p. 391 (2nd ed.)
- Two-zone vs single-zone mass-energy balance equations (eq. 9.49–9.53)
- MBT spark advance ranges by RPM (Tab 9.5)
- Combustion efficiency vs equivalence ratio (Fig 9.43)
- Citation block at top: ISBN, page numbers, edition.

- [ ] **Step 6.2: Heywood Ch 12 (heat transfer)**

`heywood-heat-transfer-ch12.md`:
- Annand correlation (eq. 12.39)
- Woschni 1967 correlation (eq. 12.42)
- Wall temperature assumptions (Tab 12.4)
- Heat-transfer area vs crank angle (Fig 12.18)

- [ ] **Step 6.3: Heywood Ch 13 (friction)**

`heywood-friction-ch13.md`:
- FMEP decomposition (eq. 13.21–13.25)
- Chen-Flynn polynomial form (eq. 13.26)
- Published coefficient ranges (Tab 13.5)

- [ ] **Step 6.4: Heywood Ch 6 (valve flow)**

`heywood-valve-flow-ch6.md`:
- Discharge coefficient vs L/D (Fig 6.16)
- Choked-flow criterion (eq. 6.6)
- Effective valve area vs lift (eq. 6.13)

- [ ] **Step 6.5: Original correlation papers**

Create paraphrases for:
- `woschni-1967.md` — original heat-transfer derivation, c1=2.28 baseline
- `chen-flynn-1965.md` — friction-decomposition derivation, original a/b/c values
- `engelman-1973.md` — acoustic-tuning runner-length formula
- `lumley-engines-ch4.md` — turbulent burn rate, tumble effect

- [ ] **Step 6.6: NASA-7 polynomial reference**

`burcat-nasa7-coefficients.md`:
- Polynomial form (7-coefficient Cp/R, H/RT, S/R)
- Coefficient table for {N2, O2, H2O, CO2, CO, H2, OH, NO, O, H, N} at standard temperature ranges
- Source: Burcat database, pinned version (latest as of 2025).

- [ ] **Step 6.7: Confirm corpus parses + commit**

Each file should be valid markdown — no auto-check needed.

```bash
git add physics_findings/references/literature/
git commit -m "feat(physics-findings): seed literature corpus (Heywood, Woschni, Chen-Flynn, etc.)"
```

---

## Task 7: Two-calibration reference dataset (C10 corpus — SDM25 + SDM26 baseline)

**SDM25 + SDM26 both model the Honda CBR600RR with different solver calibrations** (pre-Phase-F vs current). For Phase 0–2, "second engine" is **SDM25 against the same CBR600 dyno**, which catches coefficient over-fit as the SDM25 result diverging. Phase 4 broadens to a truly different engine. See spec C10 "Phase reconciliation" for the rationale.

**Files:**
- Create: `physics_findings/references/dyno/cbr600rr-fsae-restricted.csv` (CBR600RR — FSAE 20mm restrictor target)
- Create: `physics_findings/references/dyno/cbr600rr-stock-unrestricted.csv` (CBR600RR — Honda factory unrestricted target)
- Create: `physics_findings/references/dyno/README.md` (provenance + per-calibration notes for SDM25 vs SDM26)
- Create: `physics_findings/references/configs/README.md` documenting that SDM25 (`crates/engine-sim/python_ref/configs/sdm25.json`) and SDM26 (`crates/engine-sim/python_ref/configs/sdm26.json`) are the two baseline calibrations against the CBR600 dyno corpus.

NOTE: original plan called for a `fsae-ka100-single-cylinder.csv` second-engine dataset. SUPERSEDED by the SDM25 + SDM26 two-calibration baseline (the user redirected mid-execution). External-engine cross-validation (KA100, CRF250R, FSAE published dynos, or Heywood Appendix D) lands in Phase 4 instead.

- [ ] **Step 7.1: Locate existing CBR600 calibration**

Search the existing repo for CBR600 dyno data referenced by `physics_validation_report.md`:

```powershell
Get-ChildItem -Recurse -Filter "*cbr*" -ErrorAction SilentlyContinue | Select-Object FullName
```

If a structured CSV exists, copy it. If only narrative text references in markdown, build a CSV from the published values (Honda factory: 88 kW @ 13k RPM unrestricted; FSAE-restricted dyno: 41–52 kW @ 9–13k RPM; columns: rpm, brake_power_kW, brake_torque_Nm, bsfc_g_per_kWh, egt_K).

- [ ] **Step 7.2: Source a second engine — FSAE KA100**

The KA100 is a 100cc single-cylinder kart engine widely used in FSAE training. Published dyno: ~24 hp peak @ 14k RPM. Use the SAE / KA Racing published dyno or aggregate from FSAE Online forum (cite source per data point). Build `fsae-ka100-single-cylinder.csv` with columns matching CBR600's. If a single-cylinder reference is hard to find, substitute the Honda CRF250R (published widely; ~25 hp).

The exact engine chosen matters less than having a *second* validated dataset. The Phase 1 / Phase 2 tuning fixes will validate against both per C10.

- [ ] **Step 7.3: Document provenance**

`physics_findings/references/dyno/README.md`:

```markdown
# Calibration Dyno Datasets

Each CSV uses columns: `rpm, brake_power_kW, brake_torque_Nm, bsfc_g_per_kWh, egt_K, source, notes`.

## Datasets

### CBR600RR — FSAE-restricted (20 mm)
- Source: physics_validation_report.md (this branch) + FSAE published team dynos (multi-source aggregate)
- Range: 41–52 kW @ 9k–13k RPM
- Used by: every CBR600-related finding

### CBR600RR — stock unrestricted
- Source: Honda factory spec sheet + Cycle World dyno
- Range: 88 kW @ 13k RPM
- Used by: solver-ceiling investigations

### KA100 / CRF250R — single-cylinder second reference
- Source: <cite published dyno>
- Range: <fill>
- Used by: C10 second-engine validation gate
```

- [ ] **Step 7.4: Commit**

```bash
git add physics_findings/references/dyno/
git commit -m "feat(physics-findings): seed CBR600 + second-engine calibration corpora (C10)"
```

---

## Task 8: `.physics_locks/` format + orchestrator mutex

**Files:**
- Create: `.physics_locks/README.md`
- Create: `crates/helios-bench/src/locks.rs`
- Create: `crates/helios-bench/tests/locks.rs`
- Modify: `crates/helios-bench/src/lib.rs` to expose `locks` module

- [ ] **Step 8.1: Write failing tests**

Create `crates/helios-bench/tests/locks.rs`:

```rust
//! Lock-ledger semantics per spec C3.

use helios_bench::locks::*;
use tempfile::tempdir;

#[test]
fn manifest_roundtrip() {
    let m = Manifest {
        id: 42,
        slug: "woschni-c1-c2".into(),
        worktree_path: "worktrees/agent-0042-woschni-c1-c2".into(),
        spawned_by: SpawnedBy::Manual,
        spawned_at: "2026-05-22T12:00:00Z".into(),
        files: vec!["crates/engine-sim/src/cylinder/heat.rs".into()],
    };
    let s = serde_json::to_string(&m).unwrap();
    let m2: Manifest = serde_json::from_str(&s).unwrap();
    assert_eq!(m, m2);
}

#[test]
fn no_collision_when_disjoint_files() {
    let a = Manifest { id: 1, slug: "a".into(), worktree_path: "w/a".into(), spawned_by: SpawnedBy::Manual, spawned_at: "t".into(), files: vec!["foo.rs".into()] };
    let b = Manifest { id: 2, slug: "b".into(), worktree_path: "w/b".into(), spawned_by: SpawnedBy::Manual, spawned_at: "t".into(), files: vec!["bar.rs".into()] };
    let collisions = collisions_against(&b, &[a]);
    assert!(collisions.is_empty(), "disjoint files should not collide");
}

#[test]
fn collision_when_overlapping_file() {
    let a = Manifest { id: 1, slug: "a".into(), worktree_path: "w/a".into(), spawned_by: SpawnedBy::Manual, spawned_at: "t".into(), files: vec!["foo.rs".into(), "shared.rs".into()] };
    let b = Manifest { id: 2, slug: "b".into(), worktree_path: "w/b".into(), spawned_by: SpawnedBy::Manual, spawned_at: "t".into(), files: vec!["bar.rs".into(), "shared.rs".into()] };
    let collisions = collisions_against(&b, &[a]);
    assert_eq!(collisions.len(), 1);
    assert_eq!(collisions[0].id, 1);
}

#[test]
fn mutex_o_excl_creates_exclusively() {
    let dir = tempdir().unwrap();
    let m1 = OrchestratorMutex::acquire(dir.path()).unwrap();
    // Second acquire from a *fresh* process simulator: should fail with would-block.
    let r = OrchestratorMutex::try_acquire(dir.path());
    assert!(r.is_err(), "second acquire while first held should fail: {:?}", r);
    drop(m1);
    let _m2 = OrchestratorMutex::acquire(dir.path()).unwrap();
}

#[test]
fn mutex_stale_reclaim_after_120s_and_dead_pid() {
    let dir = tempdir().unwrap();
    // Write a stale mutex file with a dead pid + old mtime.
    let path = dir.path().join("_orchestrator.mutex");
    std::fs::write(&path, r#"{"pid":4294967294,"hostname":"x","acquired_at":"2000-01-01T00:00:00Z"}"#).unwrap();
    let very_old = filetime::FileTime::from_unix_time(946684800, 0); // 2000-01-01
    filetime::set_file_mtime(&path, very_old).unwrap();
    // Reclaim should succeed.
    let _m = OrchestratorMutex::acquire(dir.path()).expect("stale mutex reclaim");
}
```

- [ ] **Step 8.2: Add `filetime` dev-dep**

Append to `crates/helios-bench/Cargo.toml`:

```toml
filetime = "0.2"
```

- [ ] **Step 8.3: Run tests, see fail**

Run: `cargo test -p helios-bench --test locks`
Expected: FAIL — `locks` module doesn't exist.

- [ ] **Step 8.4: Implement `locks.rs`**

Create `crates/helios-bench/src/locks.rs`:

```rust
//! Source-file lock ledger per spec C3.
//!
//! - Manifest: one JSON file per active investigation under `.physics_locks/`
//! - Mutex: `.physics_locks/_orchestrator.mutex` acquired by O_EXCL create

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpawnedBy {
    Manual,
    Cron,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub id: u32,
    pub slug: String,
    pub worktree_path: String,
    pub spawned_by: SpawnedBy,
    pub spawned_at: String,
    pub files: Vec<String>,
}

/// Return any manifests in `existing` that overlap on at least one file with `candidate`.
pub fn collisions_against(candidate: &Manifest, existing: &[Manifest]) -> Vec<Manifest> {
    use std::collections::HashSet;
    let cand: HashSet<&str> = candidate.files.iter().map(String::as_str).collect();
    existing.iter()
        .filter(|m| m.files.iter().any(|f| cand.contains(f.as_str())))
        .cloned()
        .collect()
}

/// Mutex over the `.physics_locks/` directory. Acquired via O_EXCL create.
pub struct OrchestratorMutex {
    path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct MutexContent {
    pid: u32,
    hostname: String,
    acquired_at: String,
}

const MUTEX_STALE_SECS: u64 = 120;

impl OrchestratorMutex {
    pub fn acquire(locks_dir: &Path) -> Result<Self> {
        // Try first; reclaim if stale; bail otherwise.
        match Self::try_acquire(locks_dir) {
            Ok(m) => Ok(m),
            Err(_) => {
                Self::reclaim_if_stale(locks_dir)?;
                Self::try_acquire(locks_dir).context("acquire after reclaim")
            }
        }
    }

    pub fn try_acquire(locks_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(locks_dir)?;
        let path = locks_dir.join("_orchestrator.mutex");
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)  // O_EXCL
            .open(&path)
            .map_err(|e| anyhow!("acquire mutex {}: {}", path.display(), e))?;
        let content = MutexContent {
            pid: std::process::id(),
            hostname: gethostname().unwrap_or_else(|| "unknown".into()),
            acquired_at: chrono_rfc3339(),
        };
        let body = serde_json::to_string(&content)?;
        f.write_all(body.as_bytes())?;
        f.flush()?;
        Ok(Self { path })
    }

    fn reclaim_if_stale(locks_dir: &Path) -> Result<()> {
        let path = locks_dir.join("_orchestrator.mutex");
        if !path.exists() {
            return Ok(());
        }
        let meta = std::fs::metadata(&path)?;
        let mtime = meta.modified()?;
        let age_secs = std::time::SystemTime::now().duration_since(mtime).map(|d| d.as_secs()).unwrap_or(0);
        let body = std::fs::read_to_string(&path)?;
        let content: MutexContent = serde_json::from_str(&body)?;
        let pid_alive = pid_is_running(content.pid);
        if age_secs > MUTEX_STALE_SECS && !pid_alive {
            std::fs::remove_file(&path).context("unlink stale mutex")?;
            Ok(())
        } else {
            bail!("mutex held: pid {} ({}s old, alive={pid_alive})", content.pid, age_secs);
        }
    }
}

impl Drop for OrchestratorMutex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn gethostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok().or_else(|| std::env::var("HOSTNAME").ok())
}

fn chrono_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{}Z", iso8601_from_unix(secs))
}

fn iso8601_from_unix(s: u64) -> String {
    // Minimal: emit as Unix seconds in ISO-ish form. Good enough for audit log.
    format!("unix-{s}")
}

#[cfg(windows)]
fn pid_is_running(pid: u32) -> bool {
    // OpenProcess(SYNCHRONIZE, false, pid); if it succeeds and GetExitCodeProcess returns STILL_ACTIVE, alive.
    use std::os::windows::raw::HANDLE;
    extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, pid: u32) -> HANDLE;
        fn GetExitCodeProcess(handle: HANDLE, exit_code: *mut u32) -> i32;
        fn CloseHandle(handle: HANDLE) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x00100000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let h = OpenProcess(SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE
    }
}

#[cfg(unix)]
fn pid_is_running(pid: u32) -> bool {
    // kill(pid, 0) returns success if the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}
```

- [ ] **Step 8.5: Add `libc` cfg(unix) dep**

Append to `crates/helios-bench/Cargo.toml`:

```toml
[target.'cfg(unix)'.dependencies]
libc = "0.2"
```

Add `pub mod locks;` to `crates/helios-bench/src/lib.rs`.

- [ ] **Step 8.6: Build + test**

Run: `cargo build -p helios-bench`
Expected: PASS.

Run: `cargo test -p helios-bench --test locks`
Expected: PASS.

- [ ] **Step 8.7: Write `.physics_locks/README.md`**

```markdown
# .physics_locks

Write-claim manifests for active physics investigations (spec C3).

## Files

- `_orchestrator.mutex` — held by the orchestrator while reading/writing this directory. O_EXCL create. Released on drop. Stale-mutex detection: mtime > 120 s AND pid not running → reclaimable.
- `NNNN-<slug>.lock` — one per active investigation. JSON:

```json
{
  "id": 42,
  "slug": "woschni-c1-c2",
  "worktree_path": "worktrees/agent-0042-woschni-c1-c2",
  "spawned_by": "manual",
  "spawned_at": "2026-05-22T12:00:00Z",
  "files": [
    "crates/engine-sim/src/cylinder/heat.rs",
    "crates/cfd-core/tests/regressions/r0042_woschni_c1_c2.rs"
  ]
}
```

Locks are committed to `physics-fixes/math-corrections` from the main checkout only. Worktrees see them read-only through shared `.git`. The `.githooks/pre-commit` hook refuses any commit from a worktree that touches `.physics_locks/`.
```

- [ ] **Step 8.8: Commit**

```bash
git add crates/helios-bench/src/locks.rs crates/helios-bench/src/lib.rs crates/helios-bench/tests/locks.rs crates/helios-bench/Cargo.toml .physics_locks/
git commit -m "feat(helios-bench): lock ledger + orchestrator mutex (spec C3)"
```

---

## Task 9: `.githooks/` pre-commit hook (parity + manifest + marker)

**Files:**
- Create: `.githooks/pre-commit` (bash, executable)
- Create: `.githooks/install.sh`
- Create: `.githooks/install.ps1`
- Create: `.githooks/lib/parity_runner.sh`
- Create: `.githooks/README.md`

- [ ] **Step 9.1: Write the pre-commit hook (bash)**

`.githooks/pre-commit`:

```bash
#!/usr/bin/env bash
#
# helios physics-fixes pre-commit hook.
# - Enforces source-file write-claim manifest (spec C3)
# - Runs parity test suite (spec C5)
# - Refuses commits inside an agent worktree without HELIOS_PHYSICS_AGENT=1
# - Refuses any change to crates/engine-sim/python_ref/ (parity anchor)
# - Refuses any change to .physics_locks/ from inside a worktree
#
# Install via `core.hooksPath = .githooks` (see install.sh).

set -e

# 1. Identify whether we're in an agent worktree.
worktree_root=$(git rev-parse --show-toplevel)
is_agent_worktree=0
if [[ "$worktree_root" == *"/worktrees/agent-"* ]]; then
    is_agent_worktree=1
fi

# 2. If we are, require the marker env var.
if [[ "$is_agent_worktree" == "1" && "${HELIOS_PHYSICS_AGENT:-}" != "1" ]]; then
    echo "ERROR: agent worktree commit requires HELIOS_PHYSICS_AGENT=1" >&2
    echo "       (this is the spec C5 --no-verify defense; set it in the worktree shell)" >&2
    exit 1
fi

# 3. Refuse any change to python_ref/ (parity anchor, locked by default).
staged=$(git diff --cached --name-only)
if echo "$staged" | grep -q "^crates/engine-sim/python_ref/"; then
    echo "ERROR: changes to crates/engine-sim/python_ref/ are forbidden" >&2
    echo "       (parity anchor, locked by default per spec C3)" >&2
    exit 1
fi

# 4. Refuse any change to .physics_locks/ from inside an agent worktree.
if [[ "$is_agent_worktree" == "1" ]] && echo "$staged" | grep -q "^\.physics_locks/"; then
    echo "ERROR: .physics_locks/ is writable only from main checkout" >&2
    exit 1
fi

# 5. Manifest enforcement (agent worktrees only).
if [[ "$is_agent_worktree" == "1" ]]; then
    # Manifest path: derive from worktree dir name (worktrees/agent-NNNN-slug → .physics_locks/NNNN-slug.lock)
    wt_name=$(basename "$worktree_root")
    # extract NNNN-slug
    manifest_id=${wt_name#agent-}
    main_root=$(git rev-parse --git-common-dir | xargs dirname)
    manifest_file="$main_root/.physics_locks/${manifest_id}.lock"
    if [[ ! -f "$manifest_file" ]]; then
        echo "ERROR: manifest not found: $manifest_file" >&2
        exit 1
    fi
    # Extract allowed files
    allowed=$(python -c "import json,sys; m=json.load(open(sys.argv[1])); print('\n'.join(m.get('files',[])))" "$manifest_file" 2>/dev/null || \
              jq -r '.files[]' "$manifest_file" 2>/dev/null)
    if [[ -z "$allowed" ]]; then
        echo "ERROR: could not parse files[] from $manifest_file (need python or jq)" >&2
        exit 1
    fi
    # Each staged file MUST be in the allowlist (or be in physics_findings/NNNN-slug/ — the finding's own dir is always writable)
    finding_dir="physics_findings/${manifest_id}/"
    while IFS= read -r f; do
        if [[ -z "$f" ]]; then continue; fi
        # finding-dir writes are always allowed
        if [[ "$f" == "$finding_dir"* ]]; then continue; fi
        # markdown reports at workspace root are always allowed (e.g., progress notes)
        if [[ "$f" =~ ^[A-Za-z0-9_-]+\.md$ ]]; then continue; fi
        if ! echo "$allowed" | grep -Fxq "$f"; then
            echo "ERROR: $f is not in the write-claim manifest" >&2
            echo "       Allowed:" >&2
            echo "$allowed" | sed 's/^/         /' >&2
            echo "       Either narrow the change or submit a pending_amend.json." >&2
            exit 1
        fi
    done <<< "$staged"
fi

# 6. Parity test suite (always, per spec C5).
echo "[pre-commit] running parity suite (spec C5)..."
source "$(dirname "$0")/lib/parity_runner.sh"
run_parity_tests

echo "[pre-commit] OK"
exit 0
```

- [ ] **Step 9.2: Write the parity runner**

`.githooks/lib/parity_runner.sh`:

```bash
# Shared parity-test invocation. Sourced by pre-commit and by doctor.
#
# Runs all default-flag parity tests; fails if any test fails.

run_parity_tests() {
    # engine-sim parity tests
    cargo test --quiet -p engine-sim --tests 'parity_' -- --quiet 2>&1 | tee /tmp/helios-parity-engine-sim.log
    rc=${PIPESTATUS[0]}
    if [[ $rc -ne 0 ]]; then
        echo "[pre-commit] FAIL: engine-sim parity suite" >&2
        return $rc
    fi

    # cfd-core parity tests
    cargo test --quiet -p cfd-core --tests 'parity_' -- --quiet 2>&1 | tee /tmp/helios-parity-cfd-core.log
    rc=${PIPESTATUS[0]}
    if [[ $rc -ne 0 ]]; then
        echo "[pre-commit] FAIL: cfd-core parity suite" >&2
        return $rc
    fi

    return 0
}
```

- [ ] **Step 9.3: Write the install scripts**

`.githooks/install.sh`:

```bash
#!/usr/bin/env bash
set -e
git config --local core.hooksPath .githooks
chmod +x .githooks/pre-commit
chmod +x .githooks/install.sh
echo "core.hooksPath set to .githooks"
echo "pre-commit hook activated"
```

`.githooks/install.ps1`:

```powershell
git config --local core.hooksPath .githooks
Write-Host "core.hooksPath set to .githooks"
```

- [ ] **Step 9.4: README**

`.githooks/README.md`:

```markdown
# Helios Physics-Fixes Git Hooks

These hooks enforce spec C3 (lock manifest) and spec C5 (parity gate). Activated via `core.hooksPath = .githooks` (committed to repo so all clones get them).

## Install (per clone, per worktree)

PowerShell: `.\.githooks\install.ps1`
bash: `./.githooks/install.sh`

The worktree spawn script (`scripts/physics/spawn-worktree.*`) calls this automatically.

## Bypass policy

`--no-verify` is policy-forbidden inside agent worktrees (those under `worktrees/agent-*/`). The pre-commit hook self-checks `HELIOS_PHYSICS_AGENT=1` — without it, commits from an agent worktree fail. From the main checkout, `--no-verify` is permitted for orchestrator-emergency commits but the doctor's merge-gate is the authoritative backstop.

## Maintenance

If the parity test suite changes (new file under `crates/*/tests/parity_*.rs`), the hook picks it up automatically via the cargo test glob.
```

- [ ] **Step 9.5: Activate hooks + smoke test**

Run from the main checkout:

```powershell
.\.githooks\install.ps1
```

Then verify the hook fires on a deliberate offense:

```powershell
# touch a file in python_ref to confirm rejection
echo "test" > crates/engine-sim/python_ref/SHOULD_FAIL.txt
git add crates/engine-sim/python_ref/SHOULD_FAIL.txt
# Try to commit; pre-commit should refuse.
git commit -m "should fail" 2>&1 | Select-String -Pattern "forbidden"
# Cleanup
git reset HEAD crates/engine-sim/python_ref/SHOULD_FAIL.txt
Remove-Item crates/engine-sim/python_ref/SHOULD_FAIL.txt
```

Expected: hook prints "ERROR: changes to crates/engine-sim/python_ref/ are forbidden" and exit code 1.

- [ ] **Step 9.6: Commit the hooks**

```bash
git add .githooks/
git commit -m "feat(githooks): pre-commit parity gate + manifest enforcement (spec C3 + C5)"
```

---

## Task 10: helios-bench sweep subcommand

**Files:**
- Modify: `crates/helios-bench/src/cmd/sweep.rs`
- Create: `crates/helios-bench/tests/sweep.rs`

- [ ] **Step 10.1: Write failing test**

Create `crates/helios-bench/tests/sweep.rs`:

```rust
use std::process::Command;
use tempfile::tempdir;

fn bin() -> Command { Command::new(env!("CARGO_BIN_EXE_helios-bench")) }

#[test]
fn sweep_lhs_8_trials_produces_8_results() {
    let dir = tempdir().unwrap();
    let study = dir.path().join("study.toml");
    let out = dir.path().join("sweep.ndjson");

    let cfg = std::fs::canonicalize(
        "../engine-sim/python_ref/golden_capture/configs/engine_matrix_sdm26_baseline.json"
    ).unwrap();

    let toml = format!(r#"
[run]
config = "{cfg}"
rpm = [9000]
cycles = 30
recorded = true
seed = 1

[environment]
target_triple = "{}"
rustc_version = "any"
rayon_threads = 1
libm_source = "any"

[sweep]
sampler = "lhs"
n_trials = 8
parameters = [
  {{ name = "fmep_a", min = 0.3, max = 0.6 }},
]
"#,
    helios_bench::environment::target_triple(),
    cfg = cfg.display().to_string().replace('\\', "/")
);
    std::fs::write(&study, toml).unwrap();

    let r = bin().args(["sweep", study.to_str().unwrap(), "--out", out.to_str().unwrap()]).output().unwrap();
    assert!(r.status.success(), "sweep failed: stderr={}", String::from_utf8_lossy(&r.stderr));
    let body = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    // env line + 8 trials
    assert!(lines.len() >= 9, "expected 9+ lines, got {}", lines.len());
    let trial_count = lines.iter().skip(1).filter(|l| {
        let v: serde_json::Value = serde_json::from_str(l).unwrap_or(serde_json::Value::Null);
        v["kind"] == "trial"
    }).count();
    assert_eq!(trial_count, 8);
}

#[test]
fn sweep_deterministic_with_same_seed() {
    // Run two sweeps with same seed → result NDJSON contents (excluding env timestamp) identical.
    // (Implementation detail: env line includes commit_hash but not a wall clock.)
    // ... (similar setup, run twice, byte-compare excluding env line)
}
```

- [ ] **Step 10.2: Run, see fail**

Expected: FAIL — `helios-bench sweep: not yet implemented`.

- [ ] **Step 10.3: Implement `cmd/sweep.rs`**

```rust
use crate::study::Study;
use crate::environment::capture;
use crate::ndjson::ResultWriter;
use anyhow::{Context, Result};
use cfd_core::optimization::sampler::{sample, SamplerKind};
use clap::Args as ClapArgs;
use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::SDM26Engine;
use serde_json::json;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    pub study: PathBuf,
    #[arg(long)]
    pub out: PathBuf,
    #[arg(long)]
    pub commit: Option<String>,
}

pub fn execute(args: Args) -> Result<()> {
    let txt = std::fs::read_to_string(&args.study)?;
    let study: Study = toml::from_str(&txt)?;
    study.validate().map_err(|e| anyhow::anyhow!(e))?;
    let sweep = study.sweep.as_ref().ok_or_else(|| anyhow::anyhow!("[sweep] section required"))?;

    if study.run.recorded {
        std::env::set_var("RAYON_NUM_THREADS", "1");
    }

    let commit = args.commit.clone().unwrap_or_else(|| "unknown".into());
    let env = capture(study.environment.rayon_threads);
    let mut w = ResultWriter::create(&args.out, &env, study.run.seed, &commit)?;

    let kind = match sweep.sampler.as_str() {
        "lhs" => SamplerKind::Lhs,
        "random" => SamplerKind::Random,
        other => anyhow::bail!("unknown sampler: {other}"),
    };
    let samples = sample(kind, sweep.n_trials as usize, sweep.parameters.len(), study.run.seed);

    // Build trial configs (apply each parameter override deterministically).
    // The cfd-core optimization::bounds::map_to_physical fn handles min/max scaling.
    let base_cfg = load_v1_json(&study.run.config)?;
    for (trial_id, row) in samples.iter().enumerate() {
        // Sort parameter list by name to make iteration order stable (spec C4 HashMap clause).
        let mut params = sweep.parameters.clone();
        params.sort_by(|a, b| a.name.cmp(&b.name));
        let mut cfg = base_cfg.clone();
        for (p, &x01) in params.iter().zip(row.iter()) {
            let v = p.min + x01 * (p.max - p.min);
            apply_override(&mut cfg, &p.name, v)?;
        }
        let mut engine = SDM26Engine::new(cfg)?;
        for &rpm in &study.run.rpm {
            let stats = engine.run_single_rpm(rpm, study.run.cycles, None)?;
            let mut overrides = serde_json::Map::new();
            for (p, &x01) in params.iter().zip(row.iter()) {
                overrides.insert(p.name.clone(), serde_json::Value::from(p.min + x01 * (p.max - p.min)));
            }
            w.write(&json!({
                "kind": "trial",
                "trial_id": trial_id,
                "rpm": rpm,
                "overrides": overrides,
                "imep_bar": stats.imep_bar,
                "bmep_bar": stats.bmep_bar,
                "brake_power_kW": stats.brake_power_k_w,
                "mass_drift_kg": stats.mass_drift,
                "nonconservation": stats.nonconservation,
            }))?;
        }
    }
    w.finish()?;
    Ok(())
}

fn apply_override(_cfg: &mut engine_sim::config::loader::ConfigV1, name: &str, _v: f64) -> Result<()> {
    // Delegate to cfd-core's existing apply_override once the names line up.
    // For Phase 0 we accept a small allowlist; expand in Phase 1.
    anyhow::bail!("apply_override: unknown parameter {name} (Phase 0 stub)")
}
```

Note: the `apply_override` is stubbed; the actual delegation goes to `cfd_core::optimization::bounds`. Verify the existing API by reading [crates/cfd-core/src/optimization/bounds.rs](crates/cfd-core/src/optimization/bounds.rs) and adapt the call. For the smoke test in Step 10.1, the parameter `fmep_a` must be in the existing allowlist — if it isn't, swap to one that is (e.g., `wiebe_a` or whatever is there).

- [ ] **Step 10.4: Reconcile with cfd-core::optimization::bounds**

Read `crates/cfd-core/src/optimization/bounds.rs` and `crates/cfd-core/src/dto.rs` to find the existing parameter-override system. Wire `apply_override` to it. If the API doesn't quite fit, the smallest change is to expose a public function in cfd-core that accepts `(name, value)` and applies it to a config.

- [ ] **Step 10.5: Run sweep test**

Run: `cargo test -p helios-bench --test sweep -- --nocapture`
Expected: PASS.

- [ ] **Step 10.6: Commit**

```bash
git add crates/helios-bench/src/cmd/sweep.rs crates/helios-bench/tests/sweep.rs
git commit -m "feat(helios-bench): sweep subcommand wraps LHS DOE over engine-sim configs"
```

---

## Task 11: helios-bench validate subcommand

**Files:**
- Modify: `crates/helios-bench/src/cmd/validate.rs`
- Create: `crates/helios-bench/tests/validate.rs`

- [ ] **Step 11.1: Write failing test**

```rust
//! validate: checks mass/energy/momentum/positivity/monotonicity per spec C9.

use std::process::Command;
use tempfile::tempdir;
use std::io::Write;

fn bin() -> Command { Command::new(env!("CARGO_BIN_EXE_helios-bench")) }

#[test]
fn validate_passes_on_clean_ndjson() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    let mut f = std::fs::File::create(&p).unwrap();
    writeln!(f, r#"{{"kind":"environment","env":{{"target_triple":"x","rustc_version":"x","rayon_threads":1,"libm_source":"x"}},"seed":1,"commit_hash":"abc"}}"#).unwrap();
    writeln!(f, r#"{{"kind":"trial","rpm":9000,"imep_bar":9.5,"brake_power_kW":40.0,"mass_drift_kg":1e-12,"nonconservation":1e-15,"egt_mean_K":900.0}}"#).unwrap();
    drop(f);

    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(r.status.success(), "validate should PASS: stderr={}", String::from_utf8_lossy(&r.stderr));
}

#[test]
fn validate_fails_on_negative_pressure() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    let mut f = std::fs::File::create(&p).unwrap();
    writeln!(f, r#"{{"kind":"environment","env":{{"target_triple":"x","rustc_version":"x","rayon_threads":1,"libm_source":"x"}},"seed":1,"commit_hash":"abc"}}"#).unwrap();
    writeln!(f, r#"{{"kind":"trial","rpm":9000,"imep_bar":-1.0,"brake_power_kW":40.0,"mass_drift_kg":1e-12,"nonconservation":1e-15,"egt_mean_K":900.0}}"#).unwrap();
    drop(f);
    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(!r.status.success(), "validate should FAIL on negative imep");
}

#[test]
fn validate_fails_on_mass_drift_above_band() {
    // band per spec C9 is ±1e-10 relative per cycle
    let dir = tempdir().unwrap();
    let p = dir.path().join("r.ndjson");
    let mut f = std::fs::File::create(&p).unwrap();
    writeln!(f, r#"{{"kind":"environment","env":{{"target_triple":"x","rustc_version":"x","rayon_threads":1,"libm_source":"x"}},"seed":1,"commit_hash":"abc"}}"#).unwrap();
    writeln!(f, r#"{{"kind":"trial","rpm":9000,"imep_bar":9.0,"brake_power_kW":40.0,"mass_drift_kg":1.0,"mass_total_kg":1.0,"nonconservation":1e-2,"egt_mean_K":900.0}}"#).unwrap();
    drop(f);
    let r = bin().args(["validate", p.to_str().unwrap()]).output().unwrap();
    assert!(!r.status.success(), "validate should FAIL on >band mass drift");
}
```

- [ ] **Step 11.2: Run, see fail**

Expected: FAIL — not implemented.

- [ ] **Step 11.3: Implement `cmd/validate.rs`**

```rust
use anyhow::{Result, bail};
use clap::Args as ClapArgs;
use serde_json::Value;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    pub results: PathBuf,
    /// Comma-separated checks. Defaults to all.
    #[arg(long, default_value = "mass,energy,momentum,positivity,monotonicity")]
    pub checks: String,
}

pub fn execute(args: Args) -> Result<()> {
    let body = std::fs::read_to_string(&args.results)?;
    let mut env_line: Option<Value> = None;
    let mut trials: Vec<Value> = Vec::new();
    for (i, line) in body.lines().enumerate() {
        if line.is_empty() { continue; }
        let v: Value = serde_json::from_str(line)?;
        if i == 0 && v["kind"] == "environment" {
            env_line = Some(v);
        } else if v["kind"] == "trial" {
            trials.push(v);
        }
    }
    if env_line.is_none() {
        bail!("missing environment block at line 1");
    }

    let checks: Vec<&str> = args.checks.split(',').collect();
    let mut failures: Vec<String> = Vec::new();

    for (idx, t) in trials.iter().enumerate() {
        if checks.contains(&"positivity") {
            for key in ["imep_bar", "brake_power_kW", "egt_mean_K", "ve_atm"] {
                if let Some(n) = t.get(key).and_then(|v| v.as_f64()) {
                    if n < 0.0 {
                        failures.push(format!("trial {idx}: {key}={n} is negative"));
                    }
                }
            }
            if let Some(t_k) = t.get("egt_mean_K").and_then(|v| v.as_f64()) {
                if t_k < 200.0 {
                    failures.push(format!("trial {idx}: egt_mean_K={t_k} below physical floor 200 K"));
                }
            }
        }
        if checks.contains(&"mass") {
            // C9: mass drift band ±1e-10 relative per cycle.
            if let (Some(drift), Some(total)) = (
                t.get("mass_drift_kg").and_then(|v| v.as_f64()),
                t.get("mass_total_kg").and_then(|v| v.as_f64()),
            ) {
                if total > 0.0 {
                    let rel = (drift / total).abs();
                    if rel > 1e-10 {
                        failures.push(format!("trial {idx}: mass drift rel={rel:.3e} exceeds 1e-10 band"));
                    }
                }
            } else if let Some(nc) = t.get("nonconservation").and_then(|v| v.as_f64()) {
                if nc.abs() > 1e-10 {
                    failures.push(format!("trial {idx}: nonconservation={nc:.3e} exceeds 1e-10 band"));
                }
            }
        }
        // energy + momentum + monotonicity: deferred — engine-sim doesn't currently emit
        // per-cycle energy / momentum residuals. Phase 1 will plumb them through if needed.
    }

    if !failures.is_empty() {
        eprintln!("VALIDATE FAIL ({} issues):", failures.len());
        for f in &failures { eprintln!("  - {f}"); }
        bail!("validation failed");
    }
    println!("VALIDATE OK ({} trials)", trials.len());
    Ok(())
}
```

- [ ] **Step 11.4: Run + pass**

Run: `cargo test -p helios-bench --test validate -- --nocapture`
Expected: PASS.

- [ ] **Step 11.5: Commit**

```bash
git add crates/helios-bench/src/cmd/validate.rs crates/helios-bench/tests/validate.rs
git commit -m "feat(helios-bench): validate subcommand checks invariants per C9"
```

---

## Task 12: helios-bench fingerprint --suggest

**Files:**
- Modify: `crates/helios-bench/src/cmd/fingerprint.rs`
- Create: `crates/helios-bench/tests/fingerprint.rs`

- [ ] **Step 12.1: Write failing test**

```rust
use std::process::Command;

fn bin() -> Command { Command::new(env!("CARGO_BIN_EXE_helios-bench")) }

#[test]
fn suggest_outputs_nonempty_file_list() {
    // Just sanity: the suggester walks `cargo build --build-plan` (or a fallback
    // via cargo metadata) and emits a JSON list of source files. We don't pin
    // exact contents; we pin "nontrivial set including the SDM26 model file."
    let out = bin().args([
        "fingerprint", "--suggest",
        "--package", "engine-sim",
        "--bin-or-test", "parity_engine",
    ]).output().expect("spawn");
    assert!(out.status.success(), "fingerprint --suggest failed: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("crates/engine-sim/src/model/sdm26.rs"), "stdout missing sdm26.rs:\n{stdout}");
}
```

- [ ] **Step 12.2: Implement `cmd/fingerprint.rs`**

```rust
use anyhow::{Context, Result};
use clap::Args as ClapArgs;
use std::process::Command;

#[derive(ClapArgs)]
pub struct Args {
    /// Suggest mode: walk cargo metadata and output a superset of relevant files.
    #[arg(long)]
    pub suggest: bool,
    /// Workspace package to start from (e.g., engine-sim)
    #[arg(long)]
    pub package: Option<String>,
    /// Bin or test target to walk
    #[arg(long)]
    pub bin_or_test: Option<String>,
    /// Compute SHA-256 of a list of files (default mode if --suggest not set)
    #[arg(long)]
    pub files: Option<std::path::PathBuf>,
}

pub fn execute(args: Args) -> Result<()> {
    if args.suggest {
        suggest(args.package.as_deref(), args.bin_or_test.as_deref())
    } else {
        compute(args.files.as_ref())
    }
}

fn suggest(pkg: Option<&str>, _tgt: Option<&str>) -> Result<()> {
    // Use `cargo metadata` to enumerate all crates in the workspace, then
    // for the chosen package walk all `*.rs` under `src/` and `tests/`.
    let pkg = pkg.unwrap_or("engine-sim");
    let meta = Command::new("cargo").args(["metadata", "--format-version=1", "--no-deps"]).output()?;
    if !meta.status.success() { anyhow::bail!("cargo metadata failed"); }
    let v: serde_json::Value = serde_json::from_slice(&meta.stdout)?;
    let packages = v["packages"].as_array().context("packages missing")?;
    let p = packages.iter().find(|p| p["name"] == pkg).context("package not found")?;
    let manifest_dir = std::path::Path::new(p["manifest_path"].as_str().unwrap()).parent().unwrap().to_path_buf();
    let workspace_root = std::path::Path::new(v["workspace_root"].as_str().unwrap()).to_path_buf();
    // Walk *.rs in manifest_dir/src and manifest_dir/tests
    let mut out: Vec<String> = Vec::new();
    for sub in ["src", "tests"] {
        let d = manifest_dir.join(sub);
        if !d.exists() { continue; }
        walk_rs(&d, &workspace_root, &mut out);
    }
    out.sort();
    for f in &out { println!("{f}"); }
    Ok(())
}

fn walk_rs(d: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
    if let Ok(rd) = std::fs::read_dir(d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { walk_rs(&p, root, out); continue; }
            if p.extension().map(|x| x == "rs").unwrap_or(false) {
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

fn compute(files: Option<&std::path::PathBuf>) -> Result<()> {
    use sha2::{Sha256, Digest};
    let files = files.context("--files <path-to-list> required when not --suggest")?;
    let body = std::fs::read_to_string(files)?;
    for f in body.lines() {
        if f.is_empty() { continue; }
        let bytes = std::fs::read(f).with_context(|| format!("read {f}"))?;
        let mut h = Sha256::new();
        h.update(&bytes);
        let digest = h.finalize();
        println!("{:x}  {f}", digest);
    }
    Ok(())
}
```

- [ ] **Step 12.3: Run + pass**

Run: `cargo test -p helios-bench --test fingerprint -- --nocapture`
Expected: PASS.

- [ ] **Step 12.4: Commit**

```bash
git add crates/helios-bench/src/cmd/fingerprint.rs crates/helios-bench/tests/fingerprint.rs
git commit -m "feat(helios-bench): fingerprint --suggest enumerates per-package source"
```

---

## Task 13: helios-bench compare subcommand

**Files:**
- Modify: `crates/helios-bench/src/cmd/compare.rs`
- Create: `crates/helios-bench/tests/compare.rs`

- [ ] **Step 13.1: Test**

```rust
// (similar shape: write two NDJSON files, invoke `compare`, expect per-metric delta table)
```

- [ ] **Step 13.2: Implement**

`compare.rs`: load two NDJSON files, align trials by `(rpm, overrides)`, compute deltas for each numeric field, print a markdown table to stdout. Non-aligned trials are reported separately.

- [ ] **Step 13.3: Pass + commit**

```bash
git add crates/helios-bench/src/cmd/compare.rs crates/helios-bench/tests/compare.rs
git commit -m "feat(helios-bench): compare subcommand emits per-metric delta table"
```

---

## Task 14: helios-bench plot subcommand

**Files:**
- Modify: `crates/helios-bench/src/cmd/plot.rs`
- Add dep `svg = "0.16"` to `crates/helios-bench/Cargo.toml`

- [ ] **Step 14.1–14.4**: emit SVG plots of P–θ, P–V, power-curve, BSFC-curve. Use the `svg` crate (lightweight). Tests check SVG header presence + at least one `<polyline>` element. Commit.

---

## Task 15: helios-mcp server

**Files:**
- Create: `crates/helios-mcp/Cargo.toml`
- Create: `crates/helios-mcp/src/main.rs`
- Create: `crates/helios-mcp/src/handlers.rs`
- Modify: workspace `Cargo.toml`

- [ ] **Step 15.1: Pick MCP Rust SDK**

Survey: `mcp-rust-sdk`, `rust-mcp`, or build a small JSON-RPC layer in-house. For Phase 0 — use the official Anthropic MCP Rust SDK if available; otherwise hand-roll a stdio JSON-RPC loop. Document the choice in the crate's README.

- [ ] **Step 15.2–15.5**: Implement `run_sim`, `submit_sweep`, `read_finding`, `list_findings`, `query_literature`, `validate_results` — each delegates to a `helios_bench::cmd::*::execute_lib(...)` function (introduce these alongside the CLI args parsing). MCP is a *convenience skin per spec C11*: it cannot expose anything the CLI doesn't.

- [ ] **Step 15.6: Smoke test**

Stdio-driven: pipe a JSON-RPC `tools/call` with `run_sim` payload, expect a response. Add `crates/helios-mcp/tests/jsonrpc.rs`.

- [ ] **Step 15.7: Commit**

```bash
git add Cargo.toml crates/helios-mcp/
git commit -m "feat(helios-mcp): MCP server wraps helios-bench CLI (spec C11)"
```

---

## Task 16: Worktree lifecycle scripts

**Files:**
- Create: `scripts/physics/spawn-worktree.ps1`
- Create: `scripts/physics/spawn-worktree.sh`
- Create: `scripts/physics/reap-worktree.ps1`
- Create: `scripts/physics/reap-worktree.sh`
- Create: `scripts/physics/process-amendments.ps1`
- Create: `scripts/physics/process-amendments.sh`
- Create: `scripts/physics/process-stale-queue.ps1`
- Create: `scripts/physics/process-stale-queue.sh`
- Create: `scripts/physics/README.md`

- [ ] **Step 16.1: spawn-worktree.ps1**

```powershell
# scripts/physics/spawn-worktree.ps1
# Usage: .\spawn-worktree.ps1 -Id 42 -Slug "woschni-c1-c2" -Files @("crates/engine-sim/src/cylinder/heat.rs")

param(
    [Parameter(Mandatory=$true)][int]$Id,
    [Parameter(Mandatory=$true)][string]$Slug,
    [Parameter(Mandatory=$true)][string[]]$Files,
    [string]$BaseBranch = "physics-fixes/math-corrections",
    [ValidateSet("manual","cron")][string]$SpawnedBy = "manual"
)

$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
$id4 = "{0:D4}" -f $Id
$dirname = "agent-$id4-$Slug"
$worktree = Join-Path $root "worktrees" $dirname
$branch = "physics/$dirname"
$lockFile = Join-Path $root ".physics_locks" "$id4-$Slug.lock"
$mutex = Join-Path $root ".physics_locks" "_orchestrator.mutex"

# 1. Acquire orchestrator mutex (O_EXCL via .NET FileStream with FileMode.CreateNew)
[void](New-Item -ItemType Directory -Force (Split-Path $mutex -Parent))
try {
    $fs = [System.IO.FileStream]::new($mutex, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $payload = @{
        pid = $PID
        hostname = $env:COMPUTERNAME
        acquired_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
} catch {
    Write-Error "Failed to acquire orchestrator mutex (held by another process?): $_"
    exit 1
}

try {
    # 2. Collision check: read every other *.lock under .physics_locks/, refuse if any file in $Files is in existing files[].
    $existing = Get-ChildItem (Join-Path $root ".physics_locks" "*.lock") -ErrorAction SilentlyContinue
    foreach ($lf in $existing) {
        $other = Get-Content $lf | ConvertFrom-Json
        $overlap = $other.files | Where-Object { $Files -contains $_ }
        if ($overlap) {
            Write-Error "COLLISION: lock $($other.id)-$($other.slug) holds: $overlap"
            exit 1
        }
    }

    # 3. Write the manifest
    $manifest = @{
        id = $Id
        slug = $Slug
        worktree_path = "worktrees/$dirname"
        spawned_by = $SpawnedBy
        spawned_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        files = $Files
    } | ConvertTo-Json -Depth 5 -Compress
    Set-Content -Path $lockFile -Value $manifest -Encoding UTF8

    # 4. Commit the manifest to main checkout (NOT the worktree)
    git add $lockFile
    git commit -m "lock: spawn $id4-$Slug" --quiet

    # 5. git worktree add
    git worktree add -b $branch $worktree $BaseBranch | Out-Null

    # 6. Set hooksPath INSIDE the worktree
    Push-Location $worktree
    try {
        git config --local core.hooksPath ".githooks"
        # Verify (per spec C5)
        $hp = (git config --get core.hooksPath).Trim()
        if ($hp -ne ".githooks") {
            Write-Error "core.hooksPath verification failed: got '$hp'"
            exit 1
        }
    } finally {
        Pop-Location
    }

    # 7. Build helios-bench inside the worktree (warm target/ + verify it compiles)
    Push-Location $worktree
    try {
        $env:CARGO_TARGET_DIR = Join-Path $worktree "target"
        cargo build --quiet -p helios-bench
    } finally {
        Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
        Pop-Location
    }

    Write-Host "Spawned worktree: $worktree"
    Write-Host "Branch: $branch"
    Write-Host "Lock: $lockFile"
    Write-Host "Activate marker: set HELIOS_PHYSICS_AGENT=1 before any commit in the worktree"
}
finally {
    # 8. Release mutex
    if ($fs) { $fs.Dispose() }
    if (Test-Path $mutex) { Remove-Item $mutex -Force }
}
```

- [ ] **Step 16.2: spawn-worktree.sh**

Same logic, bash. Key bits:
- mutex via `mkdir .physics_locks/_orchestrator.mutex_dir` (mkdir is atomic on POSIX); content stored in `.mutex_dir/state.json`.
- collision check via `jq` or python over existing `*.lock` files.
- `git worktree add` + `git -C $worktree config core.hooksPath .githooks`.

- [ ] **Step 16.3: reap-worktree.{ps1,sh}**

Inverse: remove worktree, drop lock file, commit "lock: reap NNNN-slug" to main checkout.

- [ ] **Step 16.4: process-amendments + process-stale-queue**

Two PowerShell + bash scripts the orchestrator runs each dispatch cycle. Read `pending_amend.json` files, run mutex-protected collision check, commit amended manifest or write rejection. Drain `_stale_queue.ndjson` by flipping affected finding frontmatter status to INVESTIGATING.

- [ ] **Step 16.5: README**

`scripts/physics/README.md` documents each script + lifecycle.

- [ ] **Step 16.6: Smoke test**

Run `spawn-worktree.ps1` with a trivial finding id, verify worktree exists + lock present + hooksPath set + helios-bench compiled. Then `reap-worktree.ps1`. Verify cleanup.

```powershell
.\scripts\physics\spawn-worktree.ps1 -Id 9999 -Slug "phase0-smoke" -Files @("docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md")
# verify
Test-Path worktrees/agent-9999-phase0-smoke
Test-Path .physics_locks/9999-phase0-smoke.lock
(git -C worktrees/agent-9999-phase0-smoke config --get core.hooksPath) -eq ".githooks"
# cleanup
.\scripts\physics\reap-worktree.ps1 -Id 9999 -Slug "phase0-smoke"
Test-Path worktrees/agent-9999-phase0-smoke    # should be False
Test-Path .physics_locks/9999-phase0-smoke.lock # should be False
```

Expected: all checks pass.

- [ ] **Step 16.7: Commit**

```bash
git add scripts/physics/
git commit -m "feat(physics-scripts): worktree spawn/reap/amend/stale lifecycle (PowerShell + bash)"
```

---

## Task 17: Subagent definitions

**Files:**
- Create: `.claude/agents/physics-orchestrator.md`
- Create: `.claude/agents/physics-researcher.md`
- Create: `.claude/agents/physics-skeptic.md`
- Create: `.claude/agents/physics-implementer.md`
- Create: `.claude/agents/physics-doctor.md`

- [ ] **Step 17.1: physics-orchestrator.md**

```markdown
---
name: physics-orchestrator
description: Main-checkout coordinator for the physics agent loop. Picks the next investigation, declares write-claim manifest, spawns the researcher worktree, dispatches skeptic + implementer, runs the doctor merge gate. Reads physics_findings/ORCHESTRATOR.md as its playbook.
tools: [Read, Edit, Write, Bash, PowerShell, Glob, Grep, Agent]
---

You are the physics-orchestrator. You run only in the main checkout `C:\Users\nmurray\Documents\Helios`. You never edit source code; you read state, declare manifests, dispatch subagents, and merge.

Each dispatch cycle:
1. Run `scripts/physics/process-amendments.ps1` to handle pending amends.
2. Run `scripts/physics/process-stale-queue.ps1` to drain STALE events.
3. Pick the next finding from the Phase 1 priority queue (see spec §5 Phase 1) or backlog.
4. Draft `study.toml` skeleton + `[acceptance]` block (cite literature).
5. Declare write-claim manifest (list every file the agent may modify).
6. Spawn worktree: `scripts/physics/spawn-worktree.ps1 -Id NNNN -Slug ... -Files @(...)`.
7. Dispatch physics-researcher with the draft study.toml and worktree path.
8. After researcher returns: dispatch physics-skeptic for pre-run review of `[acceptance]`.
9. Dispatch researcher's actual run.
10. Dispatch physics-skeptic for post-run review.
11. Verdict-branch per spec §4.5 step 5. For VALIDATED/FIXED, dispatch physics-doctor for merge-gate.
12. On doctor green: merge to physics-fixes/math-corrections via `git merge --no-ff` + write commit message; reap worktree; release lock.
13. Refresh `physics_findings/README.md` status board.

Read the full spec at `docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md` before each dispatch — it is authoritative.
```

- [ ] **Step 17.2: physics-researcher.md**

```markdown
---
name: physics-researcher
description: Runs inside an isolated git worktree. Fills out study.toml, runs helios-bench, validates results, drafts finding.md. Cannot edit files outside the write-claim manifest (pre-commit hook enforces).
tools: [Read, Edit, Write, Bash, PowerShell, Glob, Grep, WebFetch, WebSearch]
---

You are physics-researcher. Your working directory is a git worktree at `worktrees/agent-NNNN-slug/`. Your write-claim manifest is at `.physics_locks/NNNN-slug.lock` (read-only from your worktree).

Before any commit you MUST: (1) have `HELIOS_PHYSICS_AGENT=1` set in your shell, (2) only modify files in your manifest. The pre-commit hook enforces both.

Workflow:
1. Read the orchestrator's draft `study.toml` and the literature in `physics_findings/references/literature/`.
2. Fill in `[acceptance]` with literature-justified target + tolerance + citation.
3. Wait for skeptic ACK on the acceptance band (the orchestrator coordinates this).
4. Run `helios-bench run <study.toml> --out results.ndjson` (or `sweep` for parameter studies).
5. Run `helios-bench validate results.ndjson` to confirm physics invariants.
6. Read NDJSON, compute the verdict against `[acceptance]`.
7. Draft `finding.md`: hypothesis, results, comparison vs literature with citations, conclusion.
8. Compute `baseline_fingerprint` (run `helios-bench fingerprint --suggest` then narrow to the files your study transitively touches).
9. If verdict is NEEDS-FIX: hand off to physics-implementer.

When you discover you need to edit a file outside your manifest: write `pending_amend.json` to the worktree root with the additional files + justification. Wait for orchestrator to approve.

Never `git commit --no-verify`. The hook will reject it anyway.
```

- [ ] **Step 17.3: physics-skeptic.md**

```markdown
---
name: physics-skeptic
description: Adversarial reviewer. Reads study.toml + finding.md in a read-only worktree view. Pre-run: challenges the acceptance band's literature justification. Post-run: challenges the conclusion (comparison-class errors, missed conservation, confirmation bias).
tools: [Read, Grep, Glob, Bash, WebFetch, WebSearch]
---

You are physics-skeptic. You have read-only access to a researcher's worktree. You write your verdicts to `physics_findings/NNNN-slug/challenge.md`.

Pre-run review:
- Read `study.toml` `[acceptance]` block + `literature.md`.
- Check that every metric has a citation that actually supports the target+tolerance.
- Verdict: ACK | CHALLENGE. CHALLENGE requires structured `{claim, evidence, falsification_test}`.

Post-run review:
- Read `finding.md` + `results.ndjson`.
- Check: comparison-class correctness (brake vs indicated, dry vs wet AFR, kg vs g, etc.), conservation invariants, confirmation bias (did the researcher only sweep regions where the hypothesis works?), literature consistency (any cited source contradict the conclusion?).
- Verdict: APPROVE | CHALLENGE.

Withdraw-before-re-raise rule: you may not re-raise a previously-raised challenge against the same claim without first formally withdrawing the prior one in `challenge.md`. Spec §4.3.

Maximum 3 unresolved rounds before auto-escalation to the user (the orchestrator handles this — you just keep reviewing honestly until you APPROVE).
```

- [ ] **Step 17.4: physics-implementer.md**

```markdown
---
name: physics-implementer
description: Lands fixes inside the same worktree as the researcher. Only invoked after researcher + skeptic agree on a fix. Adds regression test under crates/cfd-core/tests/regressions/.
tools: [Read, Edit, Write, Bash, PowerShell, Grep, Glob]
---

You are physics-implementer. You inherit the researcher's worktree + write-claim manifest. Your job is exactly the minimum code change that closes the finding.

Workflow:
1. Read finding.md to understand the agreed-upon fix scope.
2. Implement the change. Stay strictly within the manifest — `pending_amend.json` if needed.
3. Add a regression test to `crates/cfd-core/tests/regressions/r<NNNN>_<slug>.rs`. Test name MUST include the finding id.
4. Run the regression test alone: `cargo test --release -p cfd-core --test r<NNNN>_<slug>`.
5. Run the parity suite: `cargo test --release -p engine-sim --test 'parity_'`.
6. If either fails, fix and re-run.
7. Stage + `HELIOS_PHYSICS_AGENT=1 git commit -m "fix(<topic>): <one-line>"`. The pre-commit hook will run parity again.
8. Return to the researcher (who will re-run the study against your fix).

You may NOT:
- Touch source files outside the manifest.
- Use `--no-verify`.
- Edit `crates/engine-sim/python_ref/` (parity anchor).
- Edit `.physics_locks/`.
```

- [ ] **Step 17.5: physics-doctor.md**

```markdown
---
name: physics-doctor
description: Pre-merge gate + periodic full-sweep. Runs parity suite + baseline-fingerprint recomputation. Failure auto-reverts the merge via a follow-up revert commit (spec C1).
tools: [Read, Bash, PowerShell, Grep]
---

You are physics-doctor. You run in the main checkout.

Two modes:

**Per-merge gate** (every merge into physics-fixes/math-corrections):
1. Run `cargo test --release -p engine-sim --test 'parity_'`.
2. Run `cargo test --release -p cfd-core --test 'parity_'`.
3. Run `cargo test --release -p cfd-core --test 'regressions/'`.
4. Diff-scoped fingerprint check: for every file changed in the merge diff, find every closed finding whose `baseline_fingerprint` lists that file. Recompute fingerprints and flag any drift.
5. On drift: append to `physics_findings/_stale_queue.ndjson` `{id, slug, reason, detected_at}`. The orchestrator picks this up on its next dispatch cycle.
6. On any test failure: auto-revert the merge (`git revert <merge_commit>`) and re-open the finding.

**Periodic full sweep** (daily or every 25th merge):
1. Recompute fingerprints for EVERY closed finding.
2. Flag any drift via `_stale_queue.ndjson`.
3. Run the full parity + regression suites; report green/red.

You never make decisions about scientific correctness. You make decisions about parity + invariants only.
```

- [ ] **Step 17.6: Commit**

```bash
git add .claude/agents/
git commit -m "feat(agents): physics-* subagent definitions (orchestrator/researcher/skeptic/implementer/doctor)"
```

---

## Task 18: Workspace `.gitignore` updates

**Files:**
- Modify: `.gitignore`
- Modify: `Cargo.toml` (workspace) — already done in Task 1 but add `helios-mcp` here

- [ ] **Step 18.1: Update .gitignore**

Append to `.gitignore`:

```
# Physics agent isolation
worktrees/agent-*/
!worktrees/.gitkeep
.physics_locks/_orchestrator.mutex
.physics_locks/_orchestrator.mutex_dir/
worktrees/agent-*/pending_amend.json
worktrees/agent-*/pending_amend.rejected.json
```

- [ ] **Step 18.2: Create `worktrees/.gitkeep`**

```powershell
New-Item -ItemType Directory -Force worktrees | Out-Null
New-Item -ItemType File -Force worktrees/.gitkeep | Out-Null
```

- [ ] **Step 18.3: Commit**

```bash
git add .gitignore worktrees/.gitkeep
git commit -m "chore: gitignore worktrees + transient lock state"
```

---

## Task 19: Phase 0 end-to-end smoke test

**Files:**
- Create: `physics_findings/0000-phase0-smoke/finding.md`
- Create: `physics_findings/0000-phase0-smoke/study.toml`
- Create: `physics_findings/0000-phase0-smoke/literature.md`
- Modify: `physics_findings/README.md` to reference

This is the spec §5 Phase 0 step 0.A gate. It proves the whole pipeline works end-to-end.

- [ ] **Step 19.1: Build the trivial finding**

`physics_findings/0000-phase0-smoke/study.toml`:

```toml
[run]
config = "crates/engine-sim/python_ref/golden_capture/configs/engine_matrix_sdm26_baseline.json"
rpm = [9000]
cycles = 30
recorded = true
seed = 1

[environment]
target_triple = "x86_64-pc-windows-msvc"
rustc_version = ""  # filled at orchestrator dispatch
rayon_threads = 1
libm_source = "system"

[[acceptance]]
metric = "imep_bar"
target = 9.5
tolerance = "±1%"
citation = "engine_matrix_sdm26_baseline parity golden (commit 4f930b7)"
```

`physics_findings/0000-phase0-smoke/finding.md` (use template, set status: VALIDATED, hypothesis: "Phase 0 smoke — the existing baseline parity golden reproduces bit-exactly through helios-bench run.").

`physics_findings/0000-phase0-smoke/literature.md` (cite the existing parity test files).

- [ ] **Step 19.2: Run the full lifecycle manually — SDM26 and SDM25 both**

From the main checkout, the smoke must validate BOTH calibrations work end-to-end (spec C10 two-calibration baseline):

```powershell
# 1. Spawn worktree
.\scripts\physics\spawn-worktree.ps1 -Id 0 -Slug "phase0-smoke" -Files @()

# 2. Inside worktree
Push-Location worktrees/agent-0000-phase0-smoke
$env:HELIOS_PHYSICS_AGENT = "1"
cargo build --release -p helios-bench

# 3. Run BOTH calibrations
.\target\release\helios-bench run physics_findings/0000-phase0-smoke/study_sdm26.toml --out physics_findings/0000-phase0-smoke/results_sdm26.ndjson
.\target\release\helios-bench run physics_findings/0000-phase0-smoke/study_sdm25.toml --out physics_findings/0000-phase0-smoke/results_sdm25.ndjson

# 4. Validate both
.\target\release\helios-bench validate physics_findings/0000-phase0-smoke/results_sdm26.ndjson
.\target\release\helios-bench validate physics_findings/0000-phase0-smoke/results_sdm25.ndjson

# 5. Bit-compare against existing parity goldens
# - SDM26: compare to crates/engine-sim/fixtures/parity/engine_matrix_sdm26_characteristic_10000_5cyc.json
# - SDM25: compare to crates/engine-sim/fixtures/parity/engine_matrix_sdm25_characteristic_10000_5cyc.json
# helios-bench run output for each calibration must match its golden to 16 decimal digits.

# 6. Reap
Pop-Location
.\scripts\physics\reap-worktree.ps1 -Id 0 -Slug "phase0-smoke"
```

The two-calibration smoke catches anything that's only working for one engine's tuning (e.g., parameter-name mismatches that silently fall through to a default).

- [ ] **Step 19.3: Compare bit-exact**

In the smoke-test workflow above, step 5 is the gate. Compare the `imep_bar` value from `helios-bench run` to the value the existing `crates/cfd-core/tests/parity_engine_matrix.rs` test produces for `engine_matrix_sdm26_baseline.json` at 9000 RPM. They must match to 16 decimal digits.

If they don't match: investigate. Likely causes:
- `RAYON_NUM_THREADS` not pinned to 1 (we set it in `cmd/run.rs`)
- `apply_override` introducing FP-noise (shouldn't, but verify)
- Different engine-sim path being used (helios-bench depends on `engine-sim = { path = "../engine-sim" }`, same source)

- [ ] **Step 19.4: Mark VALIDATED + commit**

Set `status: VALIDATED` in `finding.md` frontmatter. Set `baseline_fingerprint` from `helios-bench fingerprint --suggest --package engine-sim`.

```bash
git add physics_findings/0000-phase0-smoke/
git commit -m "feat(physics-findings): 0000 Phase 0 smoke — end-to-end lifecycle validated"
```

- [ ] **Step 19.5: Refresh status board**

Update `physics_findings/README.md` to show 0000 as the first VALIDATED finding.

```bash
git add physics_findings/README.md
git commit -m "chore(physics-findings): status board includes 0000"
```

---

## Phase 0 Done Criteria

All boxes ticked:
- [x] `helios-bench` builds and `--help` lists all six subcommands
- [x] `helios-bench run` produces NDJSON with environment block first line
- [x] `helios-bench sweep` produces deterministic N-trial output with same seed
- [x] `helios-bench validate` rejects negative pressure and >1e-10 mass drift
- [x] `helios-bench fingerprint --suggest` lists workspace-relative `*.rs` files
- [x] `helios-bench compare` emits per-metric delta table
- [x] `helios-bench plot` emits SVG
- [x] `helios-mcp` server starts and responds to `tools/call run_sim`
- [x] `physics_findings/` scaffold + 10 literature paraphrases + 3 dyno datasets present
- [x] `.physics_locks/` ledger format documented; `OrchestratorMutex` tests pass
- [x] `.githooks/pre-commit` hook installed via `core.hooksPath` and rejects offending commits
- [x] `scripts/physics/spawn-worktree.{ps1,sh}` + reap + amend + stale scripts work
- [x] `.claude/agents/physics-*.md` × 5 committed
- [x] `0000-phase0-smoke` finding completes the full lifecycle (spawn → run → validate → reap) and matches the existing parity golden bit-exactly

When all 14 boxes are checked, Phase 0 is complete and Phase 1 may begin.

---

## Notes for the executor

- **Order of tasks 1–19 is largely mandatory**: each task builds on the previous. The exceptions are Tasks 13 (compare) and 14 (plot) — can land anytime. Task 15 (MCP server) can land in parallel with anything after Task 12.
- **TDD discipline**: write the failing test first, watch it fail, then implement. Spec C5 requires the test infrastructure to be solid — every subcommand has an integration test.
- **Frequent commits**: each task above is one commit per step where indicated. Don't batch.
- **Reversibility (spec C1)**: never `git push --force`, never `git reset --hard <published-commit>`, never `git commit --amend` on a commit already pushed.
- **No push to main, no release** until the user explicitly approves.
- When implementation drifts from the spec, the spec wins. Update the spec via a separate commit, run it back through the spec reviewer, then continue.
- **Read the real code, not the plan, for API shapes.** Several Rust API calls in this plan were drafted from memory and do not match the actual signatures. The reviewer's findings are pinned in the Known Issues appendix below. Resolve each at the point you touch the relevant task. The fix is always "read the actual source file, write a test against the real API, adapt."

## Known Issues — surfaced by plan review v1 (2026-05-22)

The following are real bugs in the plan above. Each one will be resolved in the task where it lands; the resolution commit's message should reference `plan-review-v1 #N`.

### API drift (compile-blockers)

- **#1 `SDM26Engine::new` signature** (affects Tasks 4, 10). Real: `pub fn new(cfg: SDM26Config, junction_kind: JunctionKind) -> Self` at [crates/engine-sim/src/model/sdm26.rs:380](../../../crates/engine-sim/src/model/sdm26.rs#L380). No `Result`, takes 2 args. Add `junction = "characteristic"` (or similar) to `study.toml` `[run]`. Drop the `?`. **RESOLVED in Task 4 (commit on physics-fixes/math-corrections):** `study::Run` now has an optional `junction: Option<String>` parsed via `parse_junction_kind`; default is `Characteristic`.
- **#2 `SDM26Engine::run_single_rpm` signature** (Tasks 4, 10). Real signature at [crates/engine-sim/src/model/sdm26.rs:759](../../../crates/engine-sim/src/model/sdm26.rs#L759): `(rpm: f64, n_cycles: usize, verbose: bool, convergence_tol_imep: f64, convergence_min_cycles: usize, stop_at_convergence: bool) -> RunResult`. Returns `RunResult { cycle_stats: Vec<CycleStats>, … }` — aggregate (last cycle, or mean of last N converged) in helios-bench. **RESOLVED in Task 4:** call site passes `(rpm, cycles, false, 0.005, 3, false)` matching the parity tests; aggregate is the LAST `CycleStats`.
- **#3 RPM type** (Tasks 2, 4, 10). Change `Run { rpm: Vec<u32> }` → `Vec<f64>` in `study.rs`. **RESOLVED in Task 2:** `Run::rpm: Vec<f64>`.
- **#4 `SamplerKind` import** (Task 10). Real path: `cfd_core::dto::SamplerKind`, not `cfd_core::optimization::sampler::SamplerKind`. Sampler is at the optimization module; the kind enum lives in dto.
- **#6 `apply_override` location** (Task 10). Real: `cfd_core::params::apply_override(cfg: &mut SDM26Config, path: &str, value: f64) -> Result<(), ParameterError>` at [crates/cfd-core/src/params.rs:271](../../../crates/cfd-core/src/params.rs#L271). DROP the stub; import the real one.
- **#7 `load_v1_json` return type** (Task 10). Real: returns `Result<SDM26Config, ConfigLoadError>` (NOT `ConfigV1`). `ConfigV1` does not exist. **RESOLVED in Task 4:** import is `use engine_sim::config::loader::load_v1_json;` and the return is `Result<SDM26Config, ConfigLoadError>` (mapped through `with_context`).
- **#8 Config file paths** (Tasks 4, 10, 19). The path `crates/engine-sim/python_ref/golden_capture/configs/engine_matrix_sdm26_baseline.json` does NOT exist. Use `crates/engine-sim/python_ref/configs/sdm26.json` for the canonical SDM26 baseline, or one of the parity fixtures under `crates/engine-sim/fixtures/parity/` (e.g., `engine_matrix_sdm26_characteristic_10000_5cyc.json`) for the bit-exact reproduce test in Task 19. **RESOLVED in Task 4:** smoke test points at `crates/engine-sim/python_ref/configs/sdm26.json` via `CARGO_MANIFEST_DIR`.

### Logic / tooling

- **#9 Task 19 incomplete.** Spec §5 0.A requires BOTH (a) reproduce a parity golden bit-exactly AND (b) run the full investigation lifecycle on the already-VALIDATED limiter bug fix. Add a Task 19b for the lifecycle drill: spawn worktree → researcher reads `crates/cfd-core/tests/physics_limiter_check.rs` → drafts study + finding → skeptic ACK → reap. This is the gate that proves the agent fleet works.
- **#10 cargo test parity glob syntax.** `cargo test -p engine-sim --test 'parity_*'` requires shell glob expansion (POSIX bash). On Windows Git Bash this works; PowerShell would need `Get-ChildItem` + dynamic args. Recommendation in `.githooks/lib/parity_runner.sh`: enumerate parity test targets from disk and emit explicit `--test parity_engine --test parity_cylinder` etc. Don't rely on glob.
- **#11 Pre-commit hook JSON parsing.** Drop the python/jq dependency. Add a `helios-bench locks parse-manifest <lock_file>` subcommand that emits the `files[]` as a newline list. Hook calls Rust → no system tool dependency on Windows.
- **#12 `iso8601_from_unix` is a placeholder.** Add `chrono = { workspace = true }` to helios-bench deps (already in workspace per `Cargo.toml:30`). Use `chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)`. **RESOLVED in Task 3:** `ResultWriter::create` stamps `timestamp_utc` via `chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)`.
- **#13 PowerShell mutex `finally` cleanup.** Guard `Remove-Item $mutex` with `if ($fs) { ... }` so a failed acquire doesn't delete a mutex held by another process.
- **#14 TDD discipline on Task 1.** Add a behavioral test in 1.1: `bin().args(["run", "no-such.toml"]).output()` asserts non-zero exit + stderr contains "not yet implemented". That gives a real failing→passing transition. **RESOLVED in Task 1:** `tests/cli.rs::stubbed_subcommand_bails_with_not_yet_implemented` exercises `validate` (kept as a stub through Phase 0 Task 4) and `run_rejects_missing_study_file` covers the post-implementation Task 4 contract.

### Improvements (non-blocking)

- **I-1 Task 5 too big** — split into 5a (PARITY_FLAGS), 5b (README + ORCHESTRATOR), 5c (templates), 5d (leaves).
- **I-2 Task 6 (literature) needs verification step** — each file ≥ 200 lines, contains ISBN + page refs.
- **I-3 Task 12 fingerprint compute path untested.** Add test.
- **I-4 Tasks 13/14 hand-wavy.** Expand with complete code per the skill's standard.
- **I-5 helios-mcp SDK choice TBD.** PIN: build an in-house stdio JSON-RPC server for Phase 0 (use `serde_json` + `tokio` for stdio loop). Avoids dependency on the moving MCP SDK ecosystem. If an official Rust MCP SDK stabilizes later, swap.
- **I-6 Pre-commit hook needs Git for Windows bash documentation note.** Add to `.githooks/README.md`: "Runs under Git for Windows' bundled bash; no separate WSL or Cygwin install is needed." Also drop `pre-commit.ps1` from the file list — not actually used by git directly.
- **I-7 Add Task 20:** `cargo test --workspace --release` as the final Phase 0 acceptance gate. Spec C5 requires parity green.
- **I-8 Normalize `worktree_path` to forward slashes** in PowerShell spawn script via `-replace '\\','/'`.
- **I-9 `RAYON_NUM_THREADS` env-var mutation is racy.** Instead: build a `rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap()` and use `install`-scoped execution.
- **I-10 Verify agent dispatch tool name.** The orchestrator subagent definition's `tools:` list references `Agent` — confirm against the env's available-agents list. If the env uses `Task` instead, fix.

### Regression-test discovery (will bite Task 17.4)

`cargo test --test r<NNNN>_<slug>` requires `crates/cfd-core/tests/r<NNNN>_<slug>.rs` (NOT a subdirectory). Cargo's default integration-test discovery is flat. Options:
- Move regression tests to `crates/cfd-core/tests/regressions_<NNNN>_<slug>.rs` (top-level, underscored naming)
- OR add explicit `[[test]]` entries to `crates/cfd-core/Cargo.toml` per regression file
- Recommendation: top-level naming, so `cargo test --test regressions_0042_woschni_c1_c2` works without Cargo.toml changes.

Update the implementer subagent definition (Task 17.4) accordingly.

### Plan-review acknowledgement

The full plan review is preserved in commit `<plan-review-v1>` (next commit). When executing, treat the items above as the spec-of-the-spec — if anything in the plan body contradicts a Known Issues item, the Known Issues item wins.
