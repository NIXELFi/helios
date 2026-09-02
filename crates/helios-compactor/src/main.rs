//! helios-compactor: drains telemetry staging into zstd parquet + 1 Hz
//! downsamples (run), and proves end-to-end integrity (verify).

use std::collections::{BTreeMap, HashMap};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use helios_compactor::api::Api;
use helios_compactor::compact::{
    build_chunk, downsample_1hz, encode_bytea_hex, StagingRow,
};
use helios_compactor::verify::{diff, index_batches, GroupData, SentWindow};

#[derive(Parser)]
#[command(name = "helios-compactor", about)]
struct Cli {
    /// Supabase project URL (default: env SUPABASE_URL)
    #[arg(long)]
    url: Option<String>,
    /// Service-role key (default: env SUPABASE_SERVICE_ROLE_KEY)
    #[arg(long)]
    service_role_key: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Compaction loop: scan staging, write parquet, mark, downsample.
    Run {
        /// Seconds between scans
        #[arg(long, default_value_t = 5)]
        interval: u64,
        /// Rows must be at least this old before compaction (late-retry settling)
        #[arg(long, default_value_t = 5)]
        settle: u32,
        /// Compact a (session, group) once this many seconds of windows are pending
        #[arg(long, default_value_t = 60)]
        min_span: i64,
        /// One pass: compact everything pending regardless of span, then exit
        #[arg(long)]
        once: bool,
        /// Also call telemetry.prune_staging() each pass (pg_cron fallback)
        #[arg(long)]
        prune: bool,
        /// Max staging rows fetched per scan
        #[arg(long, default_value_t = 2000)]
        fetch_limit: u32,
    },
    /// Integrity diff: generator JSONL dump vs parquet objects in storage.
    Verify {
        /// Session id whose objects to verify
        #[arg(long)]
        session: String,
        /// JSONL dump written by the generator (one window per line)
        #[arg(long)]
        dump: String,
        /// Channel set id for encodings/resolutions
        #[arg(long, default_value_t = 1)]
        channel_set: i64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let url = cli
        .url
        .or_else(|| std::env::var("SUPABASE_URL").ok())
        .context("--url or SUPABASE_URL required")?;
    let key = cli
        .service_role_key
        .or_else(|| std::env::var("SUPABASE_SERVICE_ROLE_KEY").ok())
        .context("--service-role-key or SUPABASE_SERVICE_ROLE_KEY required")?;
    let api = Api::new(&url, &key)?;
    match cli.cmd {
        Cmd::Run { interval, settle, min_span, once, prune, fetch_limit } => {
            run(&api, interval, settle, min_span, once, prune, fetch_limit).await
        }
        Cmd::Verify { session, dump, channel_set } => {
            verify(&api, &session, &dump, channel_set).await
        }
    }
}

async fn run(
    api: &Api,
    interval: u64,
    settle: u32,
    min_span: i64,
    once: bool,
    prune: bool,
    fetch_limit: u32,
) -> Result<()> {
    loop {
        let pass = compact_pass(api, settle, min_span, once, fetch_limit).await;
        match pass {
            Ok((chunks, rows, bytes_in, bytes_out)) if chunks > 0 => eprintln!(
                "compacted {chunks} chunk(s), {rows} rows, {bytes_in} B staged -> {bytes_out} B parquet ({:.1}x)",
                bytes_in as f64 / bytes_out.max(1) as f64
            ),
            Ok(_) => {}
            Err(e) => eprintln!("pass error (will retry): {e:#}"),
        }
        if prune {
            match api.prune_staging().await {
                Ok(n) if n > 0 => eprintln!("pruned {n} compacted rows"),
                Ok(_) => {}
                Err(e) => eprintln!("prune failed (pg_cron may own retention): {e:#}"),
            }
        }
        if once {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
    }
}

/// One scan->compact pass. Returns (chunks, rows, staged bytes, parquet bytes).
async fn compact_pass(
    api: &Api,
    settle: u32,
    min_span: i64,
    force: bool,
    fetch_limit: u32,
) -> Result<(usize, usize, usize, usize)> {
    let pending = api.fetch_pending(settle, fetch_limit).await?;
    if pending.is_empty() {
        return Ok((0, 0, 0, 0));
    }

    let mut groups: BTreeMap<(String, i32), Vec<StagingRow>> = BTreeMap::new();
    for row in pending {
        groups
            .entry((row.session_id.clone(), row.group_key))
            .or_default()
            .push(row);
    }

    let ids: Vec<String> = groups.keys().map(|(s, _)| s.clone()).collect();
    let id_refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
    let statuses = api.session_statuses(&id_refs).await?;

    let (mut chunks, mut rows_done, mut bytes_in, mut bytes_out) = (0, 0, 0, 0);
    for ((session, group_key), rows) in groups {
        let span_s = {
            let min = rows.iter().map(|r| r.t_start_us).min().unwrap_or(0);
            let max = rows.iter().map(|r| r.t_start_us).max().unwrap_or(0);
            (max - min) / 1_000_000 + 1
        };
        let ended = matches!(
            statuses.get(&session).map(String::as_str),
            Some("ended") | Some("aborted")
        );
        if !(force || ended || span_s >= min_span) {
            continue;
        }

        let chunk = build_chunk(&rows)
            .with_context(|| format!("build {session}/{group_key}"))?;
        api.upload_verified(&chunk.key, chunk.parquet.clone())
            .await
            .with_context(|| format!("upload {}", chunk.key))?;

        // 1 Hz downsample for the web read path
        let ds = downsample_1hz(&chunk.batch)?;
        if ds.num_rows() > 0 {
            let t0 = chunk.batch_t0()?;
            let ipc = helios_arrow::batch_to_ipc(&ds)?;
            api.insert_downsampled(
                &session,
                group_key,
                t0,
                ds.num_rows() as i64,
                &encode_bytea_hex(&ipc),
            )
            .await?;
        }

        // mark AFTER verified upload — crash before this re-runs idempotently
        api.mark_compacted(&session, group_key, &chunk.seqs).await?;

        chunks += 1;
        rows_done += chunk.seqs.len();
        bytes_in += chunk.input_bytes;
        bytes_out += chunk.parquet.len();
        eprintln!(
            "  {} <- {} rows, {} B",
            chunk.key,
            chunk.seqs.len(),
            chunk.parquet.len()
        );
    }
    Ok((chunks, rows_done, bytes_in, bytes_out))
}

trait BatchT0 {
    fn batch_t0(&self) -> Result<i64>;
}
impl BatchT0 for helios_compactor::compact::CompactedChunk {
    fn batch_t0(&self) -> Result<i64> {
        let t = self
            .batch
            .column(0)
            .as_any()
            .downcast_ref::<arrow::array::Int64Array>()
            .context("time_us")?;
        Ok(t.value(0).div_euclid(1_000_000) * 1_000_000)
    }
}

async fn verify(api: &Api, session: &str, dump_path: &str, channel_set: i64) -> Result<()> {
    let definition = api.channel_set(channel_set).await?;

    // sent windows
    let dump = std::fs::read_to_string(dump_path).context("read dump")?;
    let sent: Vec<SentWindow> = dump
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .context("parse dump JSONL")?;
    eprintln!("dump: {} windows", sent.len());

    // staged parquet, per group
    let mut staged: HashMap<i32, GroupData> = HashMap::new();
    let mut object_count = 0;
    let groups = api.list_objects(&format!("sessions/{session}/")).await?;
    for g in groups {
        let gk: i32 = g.name.parse().context("group dir name")?;
        let objects = api
            .list_objects(&format!("sessions/{session}/{gk}/"))
            .await?;
        let mut batches = Vec::new();
        for o in objects {
            let key = format!("sessions/{session}/{gk}/{}", o.name);
            let bytes = api.download_object(&key).await?;
            let reader =
                parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(
                    bytes::Bytes::from(bytes),
                )?
                .build()?;
            for b in reader {
                batches.push(b?);
            }
            object_count += 1;
        }
        staged.insert(gk, index_batches(&batches)?);
    }
    eprintln!("storage: {object_count} parquet object(s)");

    let report = diff(&definition, &sent, &staged)?;
    let mut total_mismatch = 0u64;
    let mut names: Vec<_> = report.keys().collect();
    names.sort();
    println!("{:<28} {:>9} {:>9} {:>9} {:>9}  max_err", "channel", "compared", "exact", "within", "MISMATCH");
    for name in names {
        let d = &report[name];
        total_mismatch += d.mismatched;
        println!(
            "{:<28} {:>9} {:>9} {:>9} {:>9}  {:.3e}",
            name, d.compared, d.exact, d.within_resolution, d.mismatched, d.max_abs_err
        );
    }
    if total_mismatch == 0 {
        println!("INTEGRITY EXACT: every transmitted sample accounted for at wire resolution");
        Ok(())
    } else {
        anyhow::bail!("{total_mismatch} mismatched samples")
    }
}
