//! NDJSON writer with required environment-block first line (spec C4).
//!
//! Every recorded helios-bench output is an NDJSON file whose first line
//! is a `{"kind":"environment", …}` block carrying the host details,
//! seed, commit hash, and an ISO8601 timestamp. Subsequent lines are
//! per-trial or per-cycle JSON objects.
//!
//! plan-review-v1 #12: timestamp uses `chrono::Utc::now().to_rfc3339_opts(
//! SecondsFormat::Secs, true)` — RFC3339 with seconds precision and a
//! trailing 'Z' for UTC.

use crate::study::Environment;
use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
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
    /// Create a new NDJSON result file. Writes the environment block as
    /// the first line; flushes immediately so the env line is durable
    /// even if subsequent writes panic.
    pub fn create(
        path: &Path,
        env: &Environment,
        seed: Option<u64>,
        commit_hash: &str,
    ) -> Result<Self> {
        let f = File::create(path)
            .with_context(|| format!("create {}", path.display()))?;
        let mut inner = BufWriter::new(f);
        let ts = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let env_line = json!({
            "kind": "environment",
            "env": env,
            "seed": seed,
            "commit_hash": commit_hash,
            "timestamp_utc": ts,
        });
        writeln!(inner, "{}", serde_json::to_string(&env_line)?)?;
        inner.flush()?;
        Ok(Self { inner, finished: false })
    }

    /// Append one NDJSON record. Flushes after every write so a crash
    /// preserves the partial result.
    pub fn write<T: Serialize>(&mut self, value: &T) -> Result<()> {
        writeln!(self.inner, "{}", serde_json::to_string(value)?)?;
        self.inner.flush()?;
        Ok(())
    }

    /// Finalize the file. Idempotent; explicit because consumers should
    /// know when the file is "complete".
    pub fn finish(mut self) -> Result<()> {
        self.inner.flush()?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for ResultWriter {
    fn drop(&mut self) {
        // Best-effort flush; we already flushed on every write but a
        // partially-buffered final byte should not be lost.
        let _ = self.inner.flush();
        let _ = self.finished; // silence unused-field warning
    }
}
