//! Thin wrappers over `helios_bench::cmd::*::execute_with`.
//!
//! Each function takes structured args and returns either a structured
//! result (which the handler serializes into the JSON-RPC response) or
//! an `anyhow::Error` (which the handler maps to a JSON-RPC error).
//!
//! These wrappers exist so the MCP handlers don't sprout dependencies
//! on `clap::Args`-style structs directly — handlers stay agnostic of
//! the CLI's flag definitions.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

use helios_bench::cmd::{plot, run, sweep, validate};

/// `run_sim` — invoke a single recorded simulation. Returns a JSON
/// object summarizing the run (path, commit, n_trials, rpms).
pub fn run_sim(study_path: &str, out_path: &str, commit: Option<&str>) -> Result<Value> {
    let args = run::Args {
        study: PathBuf::from(study_path),
        out: PathBuf::from(out_path),
        commit: commit.map(|s| s.to_string()),
    };
    let summary = run::execute_with(&args).context("run_sim execute_with")?;
    Ok(json!({
        "out_path": summary.out_path.display().to_string(),
        "commit_hash": summary.commit_hash,
        "seed": summary.seed,
        "n_trials": summary.n_trials,
        "rpms": summary.rpms,
    }))
}

/// `submit_sweep` — invoke a DOE sweep. Returns trials + parameters.
pub fn submit_sweep(study_path: &str, out_path: &str, commit: Option<&str>) -> Result<Value> {
    let args = sweep::Args {
        study: PathBuf::from(study_path),
        out: PathBuf::from(out_path),
        commit: commit.map(|s| s.to_string()),
    };
    let summary = sweep::execute_with(&args).context("submit_sweep execute_with")?;
    Ok(json!({
        "out_path": summary.out_path.display().to_string(),
        "commit_hash": summary.commit_hash,
        "seed": summary.seed,
        "trials": summary.trials,
        "rpms": summary.rpms,
        "sampler": summary.sampler,
        "parameters": summary.parameters,
    }))
}

/// `validate_results` — run physics-invariant checks on an NDJSON file.
/// `checks` is the comma-separated list (default = all).
pub fn validate_results(ndjson_path: &str, checks: Option<&str>) -> Result<Value> {
    let checks_str = checks
        .map(|s| s.to_string())
        .unwrap_or_else(|| "mass,energy,momentum,positivity,monotonicity".to_string());
    let args = validate::Args {
        results: PathBuf::from(ndjson_path),
        checks: checks_str,
    };
    let summary = validate::execute_with(&args).context("validate_results execute_with")?;
    Ok(json!({
        "pass": summary.pass,
        "n_trials": summary.n_trials,
        "failures": summary.failures,
        "skipped_checks": summary.skipped_checks,
    }))
}

/// `compare` — diff two NDJSON files. The CLI prints markdown to stdout;
/// for the MCP wrapper we capture that markdown by redirecting stdout
/// via a child process. This keeps the helios-bench library API
/// thin — we don't have to refactor `compare::execute` to return its
/// markdown as a String just for the MCP. The child process is the
/// same `helios-bench` binary that's already on disk.
///
/// Path resolution: we honor the `HELIOS_BENCH_BIN` env var (test
/// fixtures set this), then fall back to looking for `helios-bench[.exe]`
/// next to the current exe.
pub fn compare_results(a: &str, b: &str) -> Result<Value> {
    let bin = locate_helios_bench()?;
    let out = std::process::Command::new(&bin)
        .args(["compare", a, b])
        .output()
        .with_context(|| format!("spawn {} compare", bin.display()))?;
    if !out.status.success() {
        anyhow::bail!(
            "helios-bench compare failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(json!({
        "markdown": String::from_utf8_lossy(&out.stdout).to_string(),
    }))
}

/// `plot` — render SVG plots. Library API: capture by calling
/// `plot::execute_with` which writes to disk; return the SVG paths.
pub fn plot_results(ndjson_path: &str, out_dir: &str) -> Result<Value> {
    let args = plot::Args {
        results: PathBuf::from(ndjson_path),
        out_dir: PathBuf::from(out_dir),
    };
    plot::execute(args).context("plot execute")?;
    Ok(json!({
        "out_dir": out_dir,
        "files": ["power_curve.svg", "pv_loop.svg", "bsfc_curve.svg"],
    }))
}

/// `fingerprint` — currently exposed only in the file-hash mode (the
/// suggest mode is interactive).
pub fn fingerprint_files(list_path: &str) -> Result<Value> {
    // The CLI prints to stdout; capture via a child process to keep the
    // wrapper thin.
    let bin = locate_helios_bench()?;
    let out = std::process::Command::new(&bin)
        .args(["fingerprint", "--files", list_path])
        .output()
        .with_context(|| format!("spawn {} fingerprint", bin.display()))?;
    if !out.status.success() {
        anyhow::bail!(
            "helios-bench fingerprint failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    let entries: Vec<Value> = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            // `<hex>  <path>` (two spaces, sha256sum format).
            let mut parts = line.splitn(2, "  ");
            let hex = parts.next()?;
            let path = parts.next()?;
            Some(json!({"sha256": hex, "path": path}))
        })
        .collect();
    Ok(json!({"entries": entries}))
}

/// `read_finding` — read a finding's `finding.md`, separate the YAML
/// frontmatter from the body, and return both.
///
/// We resolve the path against `physics_findings/NNNN-*/finding.md`.
/// Since the slug is unknown given only `id`, we walk the directory
/// looking for the prefix `NNNN-`.
pub fn read_finding(id: u32) -> Result<Value> {
    let dir = find_finding_dir(id)?;
    let path = dir.join("finding.md");
    let body =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;

    let (frontmatter, markdown) = split_frontmatter(&body);
    let frontmatter_json: Value = if frontmatter.trim().is_empty() {
        json!({})
    } else {
        parse_yaml_frontmatter(&frontmatter)
    };
    Ok(json!({
        "id": id,
        "path": path.display().to_string(),
        "frontmatter": frontmatter_json,
        "markdown": markdown,
    }))
}

/// `list_findings` — walk `physics_findings/` returning every `NNNN-*`
/// subdirectory with a `finding.md`. Optionally filters by frontmatter
/// `status` field (case-insensitive).
pub fn list_findings(filter_status: Option<&str>) -> Result<Value> {
    let root = physics_findings_root()?;
    let mut entries: Vec<Value> = Vec::new();
    let rd = match std::fs::read_dir(&root) {
        Ok(rd) => rd,
        Err(_) => return Ok(json!({"findings": []})),
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        // Expect "NNNN-<slug>" with NNNN parseable as u32.
        let Some(dash) = name.find('-') else { continue };
        let id_part = &name[..dash];
        let slug = &name[dash + 1..];
        let Ok(id) = id_part.parse::<u32>() else { continue };
        let finding_md = ent.path().join("finding.md");
        if !finding_md.is_file() {
            continue;
        }
        let body = std::fs::read_to_string(&finding_md).unwrap_or_default();
        let (frontmatter, _) = split_frontmatter(&body);
        let fm = parse_yaml_frontmatter(&frontmatter);
        let status = fm
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let topic = fm
            .get("topic")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(want) = filter_status {
            if !status.eq_ignore_ascii_case(want) {
                continue;
            }
        }
        entries.push(json!({
            "id": id,
            "slug": slug,
            "status": status,
            "topic": topic,
            "path": ent.path().display().to_string(),
        }));
    }
    // Stable order by id.
    entries.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_u64)
            .cmp(&b.get("id").and_then(Value::as_u64))
    });
    Ok(json!({"findings": entries}))
}

/// `query_literature` — case-insensitive substring grep over
/// `physics_findings/references/literature/*.md`. Returns file path,
/// matching line numbers, and a short context window per match.
pub fn query_literature(topic: &str, max_results: Option<u32>) -> Result<Value> {
    let root = physics_findings_root()?.join("references").join("literature");
    let max = max_results.unwrap_or(20) as usize;
    let needle = topic.to_lowercase();
    let mut citations: Vec<Value> = Vec::new();

    let rd = match std::fs::read_dir(&root) {
        Ok(rd) => rd,
        Err(_) => return Ok(json!({"citations": []})),
    };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .collect();
    files.sort();

    for path in files {
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        let lines: Vec<&str> = body.lines().collect();
        let mut matches: Vec<Value> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let start = i.saturating_sub(1);
                let end = (i + 2).min(lines.len());
                let context = lines[start..end].join("\n");
                matches.push(json!({
                    "line_number": i + 1,
                    "context": context,
                }));
            }
        }
        if !matches.is_empty() {
            citations.push(json!({
                "path": path.display().to_string(),
                "filename": path
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_default(),
                "matches": matches,
            }));
            if citations.len() >= max {
                break;
            }
        }
    }
    Ok(json!({"citations": citations}))
}

// ---- helpers ---------------------------------------------------------------

fn split_frontmatter(body: &str) -> (String, String) {
    // YAML frontmatter is delimited by `---` lines at the very start.
    if !body.starts_with("---") {
        return (String::new(), body.to_string());
    }
    let mut lines = body.lines();
    // Skip the opening `---`.
    let _ = lines.next();
    let mut fm_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    let mut after: Vec<&str> = Vec::new();
    for l in lines {
        if !closed {
            if l.trim() == "---" {
                closed = true;
                continue;
            }
            fm_lines.push(l);
        } else {
            after.push(l);
        }
    }
    if !closed {
        // No closing delimiter — treat whole body as markdown.
        return (String::new(), body.to_string());
    }
    (fm_lines.join("\n"), after.join("\n"))
}

/// Very lightweight YAML frontmatter parser: scalar key/value lines only.
/// Not a full YAML implementation — findings frontmatter is one-line
/// scalars per the template. We keep this in-house rather than pulling
/// in `serde_yaml` for one use-site.
fn parse_yaml_frontmatter(fm: &str) -> Value {
    let mut map = serde_json::Map::new();
    for line in fm.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim().to_string();
        let val = line[colon + 1..].trim().to_string();
        // Strip surrounding quotes if present.
        let val = val
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .map(|s| s.to_string())
            .unwrap_or(val);
        // Treat "~" as null (YAML convention).
        let v: Value = if val == "~" {
            Value::Null
        } else if let Ok(n) = val.parse::<i64>() {
            Value::from(n)
        } else if let Ok(f) = val.parse::<f64>() {
            Value::from(f)
        } else {
            Value::from(val)
        };
        map.insert(key, v);
    }
    Value::Object(map)
}

fn physics_findings_root() -> Result<PathBuf> {
    // Honor an override (used by tests + future re-roots).
    if let Ok(p) = std::env::var("HELIOS_PHYSICS_FINDINGS_DIR") {
        return Ok(PathBuf::from(p));
    }
    // Best-effort: walk up from CWD looking for a `physics_findings/` dir.
    let mut cur = std::env::current_dir()?;
    loop {
        let candidate = cur.join("physics_findings");
        if candidate.is_dir() {
            return Ok(candidate);
        }
        if !cur.pop() {
            anyhow::bail!("could not locate physics_findings/ from CWD or HELIOS_PHYSICS_FINDINGS_DIR");
        }
    }
}

fn find_finding_dir(id: u32) -> Result<PathBuf> {
    let root = physics_findings_root()?;
    let prefix = format!("{:04}-", id);
    for ent in std::fs::read_dir(&root)?.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) {
            return Ok(ent.path());
        }
    }
    anyhow::bail!("no finding directory found for id {id} (expected prefix {prefix})");
}

fn locate_helios_bench() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HELIOS_BENCH_BIN") {
        return Ok(PathBuf::from(p));
    }
    // Look next to the current exe.
    let exe = std::env::current_exe().context("current_exe")?;
    let dir = exe
        .parent()
        .context("current_exe has no parent")?
        .to_path_buf();
    for name in ["helios-bench.exe", "helios-bench"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    anyhow::bail!(
        "could not locate helios-bench binary (set HELIOS_BENCH_BIN or place next to helios-mcp)"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_frontmatter_basic() {
        let body = "---\nid: 1\nslug: foo\n---\n\n# body\nhello\n";
        let (fm, md) = split_frontmatter(body);
        assert!(fm.contains("id: 1"));
        assert!(md.contains("# body"));
    }

    #[test]
    fn split_frontmatter_no_delims() {
        let body = "no frontmatter here\nplain markdown\n";
        let (fm, md) = split_frontmatter(body);
        assert_eq!(fm, "");
        assert_eq!(md, body);
    }

    #[test]
    fn parse_yaml_handles_scalars_and_tilde() {
        let fm = "id: 7\nslug: foo\nclosed: ~\ncount: 3.14\n";
        let v = parse_yaml_frontmatter(fm);
        assert_eq!(v["id"], 7);
        assert_eq!(v["slug"], "foo");
        assert!(v["closed"].is_null());
        assert_eq!(v["count"], 3.14);
    }

    #[test]
    fn list_findings_with_temp_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("physics_findings");
        std::fs::create_dir_all(root.join("0001-foo")).unwrap();
        std::fs::write(
            root.join("0001-foo").join("finding.md"),
            "---\nid: 1\nslug: foo\nstatus: INVESTIGATING\ntopic: test thing\n---\nbody\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("0002-bar")).unwrap();
        std::fs::write(
            root.join("0002-bar").join("finding.md"),
            "---\nid: 2\nslug: bar\nstatus: VALIDATED\ntopic: another\n---\n",
        )
        .unwrap();

        let _guard = EnvGuard::set("HELIOS_PHYSICS_FINDINGS_DIR", root.to_str().unwrap());
        let v = list_findings(None).unwrap();
        let findings = v["findings"].as_array().unwrap();
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0]["id"], 1);
        assert_eq!(findings[1]["id"], 2);

        let v = list_findings(Some("VALIDATED")).unwrap();
        let findings = v["findings"].as_array().unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0]["slug"], "bar");
    }

    /// Tiny env-var guard that restores the prior value on drop.
    struct EnvGuard {
        key: String,
        prev: Option<String>,
    }
    impl EnvGuard {
        fn set(key: &str, val: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, val);
            Self {
                key: key.to_string(),
                prev,
            }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(&self.key, v),
                None => std::env::remove_var(&self.key),
            }
        }
    }

}
