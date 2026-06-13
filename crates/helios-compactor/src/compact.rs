//! Pure compaction logic: staging rows -> parquet bytes + deterministic key,
//! and 1 Hz downsampling. No I/O here; everything is unit-testable.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use arrow::array::{ArrayRef, Float64Array, Int64Array};
use arrow::compute::concat_batches;
use arrow::datatypes::DataType;
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::WriterProperties;
use serde::Deserialize;

/// One `telemetry.staging_chunks` row as PostgREST returns it.
#[derive(Debug, Clone, Deserialize)]
pub struct StagingRow {
    pub session_id: String,
    pub group_key: i32,
    pub seq: i64,
    pub t_start_us: i64,
    /// bytea over JSON: "\x<hex>"
    pub payload: String,
    pub sample_count: i32,
    pub created_at: String,
}

/// Decodes PostgREST's `\x`-prefixed hex bytea representation.
pub fn decode_bytea_hex(s: &str) -> Result<Vec<u8>> {
    let hex = s.strip_prefix("\\x").unwrap_or(s);
    if hex.len() % 2 != 0 {
        bail!("odd-length bytea hex");
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).context("bad bytea hex"))
        .collect()
}

pub fn encode_bytea_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("\\x");
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Deterministic object key: same pending range -> same key, so a retried
/// upload overwrites rather than duplicating.
pub fn object_key(session_id: &str, group_key: i32, first_seq: i64, last_seq: i64) -> String {
    format!("sessions/{session_id}/{group_key}/{first_seq}-{last_seq}.parquet")
}

pub struct CompactedChunk {
    pub key: String,
    pub parquet: Vec<u8>,
    pub batch: RecordBatch,
    pub seqs: Vec<i64>,
    pub input_bytes: usize,
}

/// Concatenates the rows' IPC batches (sorted by seq) into one parquet blob.
pub fn build_chunk(rows: &[StagingRow]) -> Result<CompactedChunk> {
    if rows.is_empty() {
        bail!("no rows to compact");
    }
    let mut rows: Vec<&StagingRow> = rows.iter().collect();
    rows.sort_by_key(|r| r.seq);

    let mut batches = Vec::with_capacity(rows.len());
    let mut input_bytes = 0;
    for r in &rows {
        let ipc = decode_bytea_hex(&r.payload)
            .with_context(|| format!("seq {} payload", r.seq))?;
        input_bytes += ipc.len();
        batches.push(
            helios_arrow::batch_from_ipc(&ipc)
                .with_context(|| format!("seq {} IPC decode", r.seq))?,
        );
    }
    let schema = batches[0].schema();
    let batch = concat_batches(&schema, &batches).context("concat record batches")?;

    let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?))
        .build();
    let mut parquet = Vec::new();
    let mut writer = ArrowWriter::try_new(&mut parquet, schema, Some(props))?;
    writer.write(&batch)?;
    writer.close()?;

    let first = rows.first().unwrap().seq;
    let last = rows.last().unwrap().seq;
    Ok(CompactedChunk {
        key: object_key(&rows[0].session_id, rows[0].group_key, first, last),
        parquet,
        batch,
        seqs: rows.iter().map(|r| r.seq).collect(),
        input_bytes,
    })
}

/// Mean-per-second downsample of a compacted batch (schema: time_us Int64 +
/// Float64 channels — the staging window schema). Aggregation: arithmetic
/// mean of all samples whose `time_us` falls in the same whole second; the
/// output timestamp is the start of that second.
pub fn downsample_1hz(batch: &RecordBatch) -> Result<RecordBatch> {
    let schema = batch.schema();
    if schema.field(0).name() != "time_us" || schema.field(0).data_type() != &DataType::Int64 {
        bail!("expected time_us Int64 as column 0");
    }
    let time = batch
        .column(0)
        .as_any()
        .downcast_ref::<Int64Array>()
        .context("time_us not Int64")?;

    // second -> (per-channel sum, count)
    let n_ch = batch.num_columns() - 1;
    let mut acc: BTreeMap<i64, (Vec<f64>, u32)> = BTreeMap::new();
    for row in 0..batch.num_rows() {
        let sec = time.value(row).div_euclid(1_000_000);
        let e = acc.entry(sec).or_insert_with(|| (vec![0.0; n_ch], 0));
        e.1 += 1;
        for c in 0..n_ch {
            let col = batch
                .column(c + 1)
                .as_any()
                .downcast_ref::<Float64Array>()
                .context("channel column not Float64")?;
            e.0[c] += col.value(row);
        }
    }

    let times: Int64Array = acc.keys().map(|s| Some(s * 1_000_000)).collect();
    let mut cols: Vec<ArrayRef> = vec![Arc::new(times)];
    for c in 0..n_ch {
        let col: Float64Array = acc
            .values()
            .map(|(sums, n)| Some(sums[c] / *n as f64))
            .collect();
        cols.push(Arc::new(col));
    }
    RecordBatch::try_new(schema, cols).context("build 1hz batch")
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::datatypes::{Field, Schema};

    fn window(t0: i64, rate: usize, base: f64) -> (RecordBatch, Vec<u8>) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("time_us", DataType::Int64, false),
            Field::new("engine.rpm", DataType::Float64, true),
        ]));
        let times: Int64Array = (0..rate)
            .map(|i| Some(t0 + (i as i64 * 1_000_000) / rate as i64))
            .collect();
        let vals: Float64Array = (0..rate).map(|i| Some(base + i as f64)).collect();
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(times), Arc::new(vals)]).unwrap();
        let ipc = helios_arrow::batch_to_ipc(&batch).unwrap();
        (batch, ipc)
    }

    fn row(seq: i64, t0: i64, ipc: &[u8]) -> StagingRow {
        StagingRow {
            session_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            group_key: 0,
            seq,
            t_start_us: t0,
            payload: encode_bytea_hex(ipc),
            sample_count: 10,
            created_at: "2026-06-12T00:00:00Z".into(),
        }
    }

    #[test]
    fn bytea_hex_roundtrip() {
        let b = vec![0u8, 1, 0xab, 0xff];
        assert_eq!(decode_bytea_hex(&encode_bytea_hex(&b)).unwrap(), b);
    }

    #[test]
    fn chunk_is_deterministic_and_roundtrips() {
        let (_, ipc0) = window(1_000_000_000, 10, 100.0);
        let (_, ipc1) = window(1_001_000_000, 10, 200.0);
        // out-of-order input: build_chunk must sort by seq
        let rows = vec![row(8, 1_001_000_000, &ipc1), row(7, 1_000_000_000, &ipc0)];

        let a = build_chunk(&rows).unwrap();
        let b = build_chunk(&rows).unwrap();
        assert_eq!(a.key, "sessions/0f8fad5b-d9cb-469f-a165-70867728950e/0/7-8.parquet");
        assert_eq!(a.key, b.key); // idempotent retry hits the same object
        assert_eq!(a.seqs, vec![7, 8]);
        assert_eq!(a.batch.num_rows(), 20);

        // parquet readback equals the concatenated batch
        let reader = parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(
            bytes::Bytes::from(a.parquet.clone()),
        )
        .unwrap()
        .build()
        .unwrap();
        let read: Vec<RecordBatch> = reader.map(|r| r.unwrap()).collect();
        let merged = concat_batches(&read[0].schema(), &read).unwrap();
        assert_eq!(merged.num_rows(), 20);
        let rpm = merged.column(1).as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(rpm.value(0), 100.0);
        assert_eq!(rpm.value(10), 200.0);
    }

    #[test]
    fn downsample_means_per_second() {
        let (batch0, _) = window(1_000_000_000, 10, 100.0); // mean 104.5
        let (batch1, _) = window(1_001_000_000, 10, 200.0); // mean 204.5
        let merged = concat_batches(&batch0.schema(), &[batch0, batch1]).unwrap();
        let ds = downsample_1hz(&merged).unwrap();
        assert_eq!(ds.num_rows(), 2);
        let t = ds.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
        let v = ds.column(1).as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(t.value(0), 1_000_000_000);
        assert_eq!(v.value(0), 104.5);
        assert_eq!(v.value(1), 204.5);
    }
}
