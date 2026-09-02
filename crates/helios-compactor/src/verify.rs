//! Integrity differ: what the generator sent (JSONL dump) vs what landed in
//! parquet, scoped to transmitted channels (handoff §5.4). f32 channels must
//! be bit-exact after f32 quantization; i16fp channels exact at their
//! documented resolution (≤ scale/2).

use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use arrow::array::{Float64Array, Int64Array};
use arrow::record_batch::RecordBatch;
use serde::Deserialize;

/// One generator window from the dump file (one JSON object per line).
#[derive(Debug, Deserialize)]
pub struct SentWindow {
    pub group_key: i32,
    pub seq: i64,
    pub t_start_us: i64,
    pub samples: HashMap<String, Vec<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChannelDef {
    id: String,
    enc: String,
    scale: Option<f64>,
    offset: Option<f64>,
}

#[derive(Debug, Default)]
pub struct ChannelDiff {
    pub compared: u64,
    pub exact: u64,
    pub within_resolution: u64,
    pub mismatched: u64,
    pub max_abs_err: f64,
}

/// Wire quantization, mirrored from the generator/edge decoder.
fn quantize(enc: &str, scale: f64, offset: f64, v: f64) -> f64 {
    match enc {
        "f32" => v as f32 as f64,
        _ => {
            let raw = ((v - offset) / scale).round().clamp(-32768.0, 32767.0);
            raw * scale + offset
        }
    }
}

pub struct GroupData {
    /// time_us -> row index
    pub time_index: HashMap<i64, usize>,
    pub columns: HashMap<String, Vec<f64>>,
}

/// Flattens parquet batches for one group into per-channel column vectors.
pub fn index_batches(batches: &[RecordBatch]) -> Result<GroupData> {
    let mut time_index = HashMap::new();
    let mut columns: HashMap<String, Vec<f64>> = HashMap::new();
    let mut row_base = 0usize;
    for batch in batches {
        let time = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .context("time_us not Int64")?;
        for i in 0..batch.num_rows() {
            time_index.insert(time.value(i), row_base + i);
        }
        for c in 1..batch.num_columns() {
            let name = batch.schema().field(c).name().clone();
            let col = batch
                .column(c)
                .as_any()
                .downcast_ref::<Float64Array>()
                .context("channel not Float64")?;
            let dst = columns.entry(name).or_default();
            dst.resize(row_base, f64::NAN);
            dst.extend((0..batch.num_rows()).map(|i| col.value(i)));
        }
        row_base += batch.num_rows();
    }
    Ok(GroupData { time_index, columns })
}

/// Diffs every sent sample against the staged value on its time grid slot.
/// `definition` is telemetry.channel_sets.definition.
pub fn diff(
    definition: &serde_json::Value,
    sent: &[SentWindow],
    staged: &HashMap<i32, GroupData>,
) -> Result<HashMap<String, ChannelDiff>> {
    let mut out: HashMap<String, ChannelDiff> = HashMap::new();
    for w in sent {
        let group = &definition["groups"][w.group_key.to_string()];
        if group.is_null() {
            bail!("group {} missing from channel set definition", w.group_key);
        }
        let rate = group["rate_hz"].as_i64().context("group rate_hz")?;
        let channels: Vec<ChannelDef> =
            serde_json::from_value(group["channels"].clone()).context("group channels")?;
        let data = staged
            .get(&w.group_key)
            .with_context(|| format!("no parquet data for group {}", w.group_key))?;

        for ch in &channels {
            let sent_vals = match w.samples.get(&ch.id) {
                Some(v) => v,
                None => continue,
            };
            let (scale, offset) = (ch.scale.unwrap_or(1.0), ch.offset.unwrap_or(0.0));
            let resolution = if ch.enc == "f32" { 0.0 } else { scale / 2.0 };
            let d = out.entry(ch.id.clone()).or_default();
            let col = data
                .columns
                .get(&ch.id)
                .with_context(|| format!("channel {} missing from parquet", ch.id))?;

            for (i, v) in sent_vals.iter().enumerate() {
                // edge time grid: t_start + round(i * 1e6 / rate)
                let t = w.t_start_us + ((i as f64) * 1_000_000.0 / rate as f64).round() as i64;
                let row = match data.time_index.get(&t) {
                    Some(r) => *r,
                    None => {
                        d.compared += 1;
                        d.mismatched += 1;
                        continue;
                    }
                };
                let expected = quantize(&ch.enc, scale, offset, *v);
                let got = col[row];
                let err = (got - expected).abs();
                d.compared += 1;
                d.max_abs_err = d.max_abs_err.max(err);
                if got == expected {
                    d.exact += 1;
                } else if err <= resolution + f64::EPSILON {
                    d.within_resolution += 1;
                } else {
                    d.mismatched += 1;
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_f32_and_i16fp() {
        assert_eq!(quantize("f32", 1.0, 0.0, 0.1), 0.1f32 as f64);
        // i16fp scale .01: 80.004 -> raw 8000 -> 80.0 (within scale/2)
        assert_eq!(quantize("i16fp", 0.01, 0.0, 80.004), 80.0);
        // clamping
        assert_eq!(quantize("i16fp", 1.0, 0.0, 1e9), 32767.0);
    }
}
