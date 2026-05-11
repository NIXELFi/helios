use helios_arrow::rate_group_to_ipc;
use helios_csv::{load_csv as csv_load, ChannelRegistry};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct LoadedRateGroup {
    pub id: String,
    pub nominal_rate_hz: f32,
    pub channel_metas: Vec<helios_core::ChannelMeta>,
    /// Arrow IPC stream bytes (one RecordBatch).
    pub ipc: Vec<u8>,
}

#[derive(Serialize, Clone)]
pub struct LoadCsvResponse {
    pub rate_groups: Vec<LoadedRateGroup>,
    pub warnings: Vec<String>,
    pub duration_us: i64,
}

#[tauri::command]
pub fn load_csv(path: String, registry_path: String) -> Result<LoadCsvResponse, String> {
    let registry = ChannelRegistry::from_path(&PathBuf::from(&registry_path))
        .map_err(|e| format!("registry load: {e}"))?;
    let result = csv_load(&PathBuf::from(&path), &registry)
        .map_err(|e| format!("csv load: {e}"))?;
    let mut rate_groups = Vec::new();
    for rg in result.rate_groups {
        let metas: Vec<_> = rg.channel_ids().into_iter()
            .map(|id| {
                rg.meta(id)
                    .cloned()
                    .ok_or_else(|| format!("missing meta for channel {}", id))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let ipc = rate_group_to_ipc(&rg).map_err(|e| format!("ipc: {e}"))?;
        rate_groups.push(LoadedRateGroup {
            id: rg.id.clone(),
            nominal_rate_hz: rg.nominal_rate_hz,
            channel_metas: metas,
            ipc,
        });
    }
    Ok(LoadCsvResponse {
        rate_groups,
        warnings: result.warnings,
        duration_us: result.duration_us,
    })
}
