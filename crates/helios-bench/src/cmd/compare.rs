//! `helios-bench compare` — diff two NDJSON sweep results.
//!
//! Trials align by the pair `(rpm, overrides)`. The override map is
//! canonicalized (key-sorted JSON) so map-iteration order doesn't
//! affect alignment.
//!
//! Output (stdout, markdown):
//!
//! - One table per aligned trial pair showing per-metric `a`, `b`,
//!   `abs_delta`, `rel_delta`.
//! - An "Unmatched" section listing trials present in only one side.
//!
//! Numeric fields are picked dynamically: any field that's a finite
//! number in both `a` and `b` is reported.

use anyhow::{Context, Result};
use clap::Args as ClapArgs;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(ClapArgs)]
pub struct Args {
    /// First NDJSON result file
    pub a: PathBuf,
    /// Second NDJSON result file
    pub b: PathBuf,
}

pub fn execute(args: Args) -> Result<()> {
    let a_trials = load_trials(&args.a)?;
    let b_trials = load_trials(&args.b)?;

    let mut a_by_key: BTreeMap<String, Value> = BTreeMap::new();
    for t in &a_trials {
        a_by_key.insert(alignment_key(t), t.clone());
    }
    let mut b_by_key: BTreeMap<String, Value> = BTreeMap::new();
    for t in &b_trials {
        b_by_key.insert(alignment_key(t), t.clone());
    }

    // Aligned trials: keys present in both.
    let mut aligned: Vec<(String, Value, Value)> = Vec::new();
    for (k, a_t) in &a_by_key {
        if let Some(b_t) = b_by_key.get(k) {
            aligned.push((k.clone(), a_t.clone(), b_t.clone()));
        }
    }
    // Stable iteration order — BTreeMap iter is already sorted.

    let mut a_only: Vec<&Value> = Vec::new();
    let mut b_only: Vec<&Value> = Vec::new();
    for (k, v) in &a_by_key {
        if !b_by_key.contains_key(k) {
            a_only.push(v);
        }
    }
    for (k, v) in &b_by_key {
        if !a_by_key.contains_key(k) {
            b_only.push(v);
        }
    }

    // Emit markdown.
    println!("# helios-bench compare");
    println!();
    println!("- a: `{}`", args.a.display());
    println!("- b: `{}`", args.b.display());
    println!(
        "- aligned: {}, a-only: {}, b-only: {}",
        aligned.len(),
        a_only.len(),
        b_only.len()
    );
    println!();

    for (k, a_t, b_t) in &aligned {
        println!("## Trial `{k}`");
        println!();
        println!("| metric | a | b | abs_delta | rel_delta |");
        println!("|--------|---|---|-----------|-----------|");
        let metrics = numeric_metric_keys(a_t, b_t);
        for m in &metrics {
            let av = a_t.get(m).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let bv = b_t.get(m).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let abs = bv - av;
            let rel = if av.abs() > 0.0 { abs / av } else { f64::NAN };
            println!(
                "| {m} | {} | {} | {} | {} |",
                fmt_f64(av),
                fmt_f64(bv),
                fmt_f64(abs),
                fmt_rel(rel)
            );
        }
        println!();
    }

    println!("## Unmatched");
    println!();
    if a_only.is_empty() && b_only.is_empty() {
        println!("_(none)_");
    } else {
        if !a_only.is_empty() {
            println!("### Only in a");
            println!();
            for t in &a_only {
                println!("- {}", alignment_key(t));
            }
            println!();
        }
        if !b_only.is_empty() {
            println!("### Only in b");
            println!();
            for t in &b_only {
                println!("- {}", alignment_key(t));
            }
            println!();
        }
    }
    Ok(())
}

fn load_trials(path: &std::path::Path) -> Result<Vec<Value>> {
    let body = std::fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in body.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| anyhow::anyhow!("{}:{}: {e}", path.display(), i + 1))?;
        if v.get("kind").and_then(Value::as_str) == Some("trial") {
            out.push(v);
        }
    }
    Ok(out)
}

/// Build a deterministic alignment key from `(rpm, overrides)`. The
/// `overrides` map is serialized via `BTreeMap` so map iteration
/// order does not affect equality.
fn alignment_key(t: &Value) -> String {
    let rpm = t
        .get("rpm")
        .and_then(Value::as_f64)
        .map(|x| format!("{:.6}", x))
        .unwrap_or_else(|| "?".into());
    let overrides_str = match t.get("overrides") {
        Some(Value::Object(m)) => {
            let sorted: BTreeMap<&String, &Value> = m.iter().collect();
            serde_json::to_string(&sorted).unwrap_or_else(|_| "{}".into())
        }
        Some(other) => other.to_string(),
        None => "{}".into(),
    };
    format!("rpm={rpm} overrides={overrides_str}")
}

fn numeric_metric_keys(a: &Value, b: &Value) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if let Some(obj) = a.as_object() {
        for (k, v) in obj {
            // Skip the alignment-key fields and the kind discriminator.
            if matches!(k.as_str(), "kind" | "rpm" | "overrides" | "trial_id") {
                continue;
            }
            if !v.is_number() {
                continue;
            }
            if let Some(bv) = b.get(k) {
                if bv.is_number() {
                    keys.push(k.clone());
                }
            }
        }
    }
    keys.sort();
    keys
}

fn fmt_f64(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.abs() < 1e-3 || x.abs() >= 1e6 {
        format!("{x:.3e}")
    } else {
        format!("{x:.6}")
    }
}

fn fmt_rel(x: f64) -> String {
    if x.is_nan() {
        "—".into()
    } else {
        format!("{:.3}%", x * 100.0)
    }
}
