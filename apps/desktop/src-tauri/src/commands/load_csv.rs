use helios_arrow::rate_group_to_ipc;
use helios_csv::{load_csv as csv_load, ChannelRegistry};
use serde::Serialize;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Binary envelope
//
// The old response serialized every Arrow IPC byte through serde_json
// (`ipc: Vec<u8>` → decimal text → JSON.parse → boxed number[]), which was the
// single biggest perf tax in the app for large CSVs. The command now returns
// one raw-bytes `tauri::ipc::Response` with this layout:
//
//   [u32 LE header_len][header JSON bytes][concatenated per-group IPC bytes]
//
// The header JSON carries everything that used to be JSON-shaped (ids, rates,
// channel metas, warnings, duration) plus, per group, the byte window
// (`ipc_offset`/`ipc_len`) of that group's Arrow IPC stream *relative to the
// start of the concatenated blob* (i.e. relative to `4 + header_len`).
// The JS decoder lives in packages/store/src/load.ts and must match this
// layout exactly.
// ---------------------------------------------------------------------------

/// One rate group loaded from CSV: metadata + its Arrow IPC stream bytes
/// (one RecordBatch).
pub struct LoadedRateGroup {
    pub id: String,
    pub nominal_rate_hz: f32,
    pub channel_metas: Vec<helios_core::ChannelMeta>,
    /// Arrow IPC stream bytes (one RecordBatch).
    pub ipc: Vec<u8>,
}

/// Per-group entry in the envelope header. `ipc_offset`/`ipc_len` locate the
/// group's Arrow IPC stream inside the envelope's concatenated blob.
#[derive(Serialize)]
struct RateGroupHeader {
    id: String,
    nominal_rate_hz: f32,
    channel_metas: Vec<helios_core::ChannelMeta>,
    ipc_offset: usize,
    ipc_len: usize,
}

#[derive(Serialize)]
struct EnvelopeHeader {
    rate_groups: Vec<RateGroupHeader>,
    warnings: Vec<String>,
    duration_us: i64,
}

/// Assemble the binary envelope from loaded rate groups. Pure — no I/O — so
/// it is unit-testable (header_len correctness, offset/len integrity).
pub fn envelope_from_groups(
    groups: Vec<LoadedRateGroup>,
    warnings: Vec<String>,
    duration_us: i64,
) -> Result<Vec<u8>, String> {
    let mut rate_groups = Vec::with_capacity(groups.len());
    let blob_len: usize = groups.iter().map(|g| g.ipc.len()).sum();
    let mut blob = Vec::with_capacity(blob_len);
    for g in groups {
        let ipc_offset = blob.len();
        let ipc_len = g.ipc.len();
        blob.extend_from_slice(&g.ipc);
        rate_groups.push(RateGroupHeader {
            id: g.id,
            nominal_rate_hz: g.nominal_rate_hz,
            channel_metas: g.channel_metas,
            ipc_offset,
            ipc_len,
        });
    }
    let header = EnvelopeHeader { rate_groups, warnings, duration_us };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("envelope header: {e}"))?;
    let header_len =
        u32::try_from(header_json.len()).map_err(|_| "envelope header exceeds u32".to_string())?;
    let mut out = Vec::with_capacity(4 + header_json.len() + blob.len());
    out.extend_from_slice(&header_len.to_le_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(&blob);
    Ok(out)
}

/// Blocking body of the command: registry YAML parse + CSV parse + Arrow IPC
/// serialization + envelope assembly. Runs on a blocking thread, never on the
/// native event loop.
fn load_csv_blocking(path: &str, registry_path: &str) -> Result<Vec<u8>, String> {
    let registry = ChannelRegistry::from_path(&PathBuf::from(registry_path))
        .map_err(|e| format!("registry load: {e}"))?;
    let result =
        csv_load(&PathBuf::from(path), &registry).map_err(|e| format!("csv load: {e}"))?;
    let mut groups = Vec::new();
    for rg in result.rate_groups {
        let metas: Vec<_> = rg.channel_ids().into_iter()
            .map(|id| {
                rg.meta(id)
                    .cloned()
                    .ok_or_else(|| format!("missing meta for channel {}", id))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let ipc = rate_group_to_ipc(&rg).map_err(|e| format!("ipc: {e}"))?;
        groups.push(LoadedRateGroup {
            id: rg.id.clone(),
            nominal_rate_hz: rg.nominal_rate_hz,
            channel_metas: metas,
            ipc,
        });
    }
    envelope_from_groups(groups, result.warnings, result.duration_us)
}

/// Async command: the parse runs inside `spawn_blocking` so the native event
/// loop (window paint included) never freezes, and the result crosses the IPC
/// bridge as raw bytes — zero JSON-encoded payload bytes.
#[tauri::command]
pub async fn load_csv(
    path: String,
    registry_path: String,
) -> Result<tauri::ipc::Response, String> {
    let envelope =
        tauri::async_runtime::spawn_blocking(move || load_csv_blocking(&path, &registry_path))
            .await
            .map_err(|e| format!("load_csv task: {e}"))??;
    Ok(tauri::ipc::Response::new(envelope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use helios_core::{ChannelMeta, DataType};

    fn meta(id: &str) -> ChannelMeta {
        ChannelMeta {
            id: id.into(), display_name: id.into(), units: "".into(),
            group: "t".into(), color: "#fff".into(), decimals: 2,
            data_type: DataType::F64, source: "t".into(),
            sample_rate_hz: 100.0, min: None, max: None, warn: None, alarm: None,
            source_header: None,
        }
    }

    fn group(id: &str, ipc: Vec<u8>) -> LoadedRateGroup {
        LoadedRateGroup {
            id: id.into(),
            nominal_rate_hz: 100.0,
            channel_metas: vec![meta("a")],
            ipc,
        }
    }

    #[test]
    fn envelope_layout_and_offsets() {
        let env = envelope_from_groups(
            vec![group("g1", vec![1, 2, 3]), group("g2", vec![4, 5, 6, 7])],
            vec!["w1".into()],
            42,
        )
        .unwrap();

        // [u32 LE header_len]
        let header_len = u32::from_le_bytes(env[0..4].try_into().unwrap()) as usize;
        let header_end = 4 + header_len;
        assert!(env.len() >= header_end, "header_len exceeds envelope");

        // [header JSON bytes]
        let header: serde_json::Value = serde_json::from_slice(&env[4..header_end]).unwrap();
        assert_eq!(header["warnings"][0], "w1");
        assert_eq!(header["duration_us"], 42);
        let rgs = header["rate_groups"].as_array().unwrap();
        assert_eq!(rgs.len(), 2);
        assert_eq!(rgs[0]["id"], "g1");
        assert_eq!(rgs[0]["ipc_offset"], 0);
        assert_eq!(rgs[0]["ipc_len"], 3);
        assert_eq!(rgs[1]["id"], "g2");
        assert_eq!(rgs[1]["ipc_offset"], 3);
        assert_eq!(rgs[1]["ipc_len"], 4);
        assert_eq!(rgs[0]["channel_metas"][0]["id"], "a");
        assert_eq!(rgs[0]["nominal_rate_hz"], 100.0);

        // [concatenated blob], offsets relative to its start
        let blob = &env[header_end..];
        assert_eq!(blob, &[1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(env.len(), header_end + 7);
    }

    #[test]
    fn envelope_empty_groups() {
        let env = envelope_from_groups(vec![], vec![], 0).unwrap();
        let header_len = u32::from_le_bytes(env[0..4].try_into().unwrap()) as usize;
        assert_eq!(env.len(), 4 + header_len, "no blob bytes expected");
        let header: serde_json::Value = serde_json::from_slice(&env[4..]).unwrap();
        assert_eq!(header["rate_groups"].as_array().unwrap().len(), 0);
    }
}
