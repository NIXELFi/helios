//! Tauri commands for the CFD tab.
//!
//! Five commands, all under the `cfd_` prefix:
//!   - `cfd_load_config(path)` — read JSON, parse with engine-sim's
//!     loader, return raw JSON + summary
//!   - `cfd_list_examples()` — enumerate bundled SDM25 + SDM26
//!   - `cfd_start_job(request)` — launch a worker thread
//!   - `cfd_cancel_job(job_id)` — set the cancel flag
//!   - `cfd_list_jobs()` — snapshot for frontend rehydration

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Window};

use cfd_core::dto::{
    ExampleConfig, JobCancelledEvent, JobDoneEvent,
    JobErrorEvent, JobProgressEvent, JobStartedEvent, JobStatus, JobSummary, LoadedConfig,
    StartJobRequest, StartJobResponse,
};
use cfd_core::runner::{
    run_single_rpm_job, DefaultDivergenceProbe, JobEmitter, RunOutcome,
};
use cfd_core::state::{CfdState, JobHandle};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------- cfd_load_config ----------------

#[tauri::command]
pub fn cfd_load_config(app: AppHandle, path: String) -> Result<LoadedConfig, String> {
    let p = PathBuf::from(&path);
    let resource_dir = app.path().resource_dir().ok();
    cfd_core::load::load_config_from_path(&p, resource_dir.as_deref())
}

// ---------------- cfd_list_examples ----------------

#[tauri::command]
pub fn cfd_list_examples(app: AppHandle) -> Vec<ExampleConfig> {
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let cfg_dir = resource_dir.join("cfd").join("configs");
    let mut out = Vec::new();
    let entries = [
        ("sdm26", "SDM26 — Honda CBR600RR (FSAE)", "Phase-F-calibrated CBR600RR I4 with 20 mm FSAE restrictor and 4-2-1 exhaust. Default starting point."),
        ("sdm25", "SDM25 — Honda CBR600RR (legacy)", "Pre-Phase-F SDM25 calibration. Same engine, older tuning; useful for comparing against Python diagnostics."),
    ];
    for (id, name, desc) in entries {
        let p = cfg_dir.join(format!("{id}.json"));
        if p.exists() {
            out.push(ExampleConfig {
                id: id.to_string(),
                name: name.to_string(),
                description: desc.to_string(),
                path: p.to_string_lossy().into_owned(),
            });
        }
    }
    out
}

// ---------------- cfd_start_job ----------------

/// Adapter that bridges JobEmitter onto Tauri's Window.emit.
struct TauriEmitter {
    window: Window,
}
impl JobEmitter for TauriEmitter {
    fn emit_started(&self, ev: JobStartedEvent) {
        let _ = self.window.emit("cfd:job-started", ev);
    }
    fn emit_progress(&self, ev: JobProgressEvent) {
        let _ = self.window.emit("cfd:job-progress", ev);
    }
    fn emit_done(&self, ev: JobDoneEvent) {
        let _ = self.window.emit("cfd:job-done", ev);
    }
    fn emit_cancelled(&self, ev: JobCancelledEvent) {
        let _ = self.window.emit("cfd:job-cancelled", ev);
    }
    fn emit_error(&self, ev: JobErrorEvent) {
        let _ = self.window.emit("cfd:job-error", ev);
    }
}

#[tauri::command]
pub fn cfd_start_job(
    window: Window,
    state: tauri::State<'_, CfdState>,
    request: StartJobRequest,
) -> Result<StartJobResponse, String> {
    let job_id = ulid::Ulid::new().to_string();
    let kind = request.kind();
    let config_path = request.config_path().to_string();
    let started_at = now_ms();

    // Register first so the running-kind gate is enforced atomically.
    let handle = JobHandle::new(kind, config_path.clone(), started_at);
    let cancel = handle.cancel.clone();
    let status = handle.status.clone();
    let finished_at_arc = handle.finished_at.clone();
    state.register(job_id.clone(), handle)?;

    // Spawn the worker. SDM26Engine isn't Send so it can never leave
    // this thread.
    let job_id_owned = job_id.clone();
    let request_clone = request.clone();
    std::thread::spawn(move || {
        let emitter = TauriEmitter { window };
        let probe = DefaultDivergenceProbe;
        let outcome = match request_clone {
            StartJobRequest::SingleRpm { config_path, params } => run_single_rpm_job(
                &emitter,
                &probe,
                job_id_owned.clone(),
                PathBuf::from(config_path),
                params,
                Arc::clone(&cancel),
                started_at,
            ),
        };
        let final_status = match outcome {
            RunOutcome::Completed(_) => JobStatus::Done,
            RunOutcome::Cancelled => JobStatus::Cancelled,
            RunOutcome::Errored => JobStatus::Error,
        };
        *status.lock().unwrap() = final_status;
        *finished_at_arc.lock().unwrap() = Some(now_ms());
    });

    Ok(StartJobResponse { job_id })
}

// ---------------- cfd_cancel_job ----------------

#[tauri::command]
pub fn cfd_cancel_job(
    state: tauri::State<'_, CfdState>,
    job_id: String,
) -> Result<(), String> {
    state.cancel_job(&job_id)
}

// ---------------- cfd_list_jobs ----------------

#[tauri::command]
pub fn cfd_list_jobs(state: tauri::State<'_, CfdState>) -> Vec<JobSummary> {
    state
        .snapshot()
        .into_iter()
        .map(|(id, kind, config_path, started_at, finished_at, status)| JobSummary {
            id,
            kind,
            status,
            config_path,
            started_at,
            finished_at,
        })
        .collect()
}

// Note: pure load logic + tests live in `cfd_core::load`. Tauri lib
// tests don't run on Windows/GNU (Tauri runtime DLL footprint causes
// STATUS_ENTRYPOINT_NOT_FOUND in the test binary), so adapter tests
// would not execute anyway.
