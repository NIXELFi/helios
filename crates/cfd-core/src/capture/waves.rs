//! Per-step wave-frame writer.
//!
//! Phase 3 captures the data; the Phase 4 viewer consumes it. Each
//! frame is one JSON line in `waves.jsonl` consisting of every pipe's
//! primitives (ρ, u, p, T) along its real cells plus per-cylinder
//! (V, p, T, x_b). A sibling `manifest.json` describes the schema and
//! is finalized when the cycle ends.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use engine_sim::model::sdm26::{CycleObserver, SDM26Engine};
use engine_sim::solver::state::primitives_from_cell;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WavePipeMeta {
    pub role: super::profiles::PipeRole,
    pub label: String,
    pub n_cells: usize,
    pub length_m: f64,
    pub index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveFrameManifest {
    pub job_id: String,
    pub rpm: f64,
    pub n_pipes: usize,
    pub pipes: Vec<WavePipeMeta>,
    pub n_cylinders: usize,
    pub step_stride: u64,
    /// Fixed by the writer; the Phase 4 viewer keys on this list.
    pub fields: Vec<String>,
    pub frame_count: u64,
    pub theta_start_deg: f64,
    pub theta_end_deg: f64,
    pub captured_cycle: i64,
    /// Set to true if writes failed mid-capture.
    pub incomplete: bool,
}

/// On-disk per-frame structure. Kept as plain JSON so debug inspection
/// is cheap; Phase 4 can swap to msgpack if parse cost becomes a
/// bottleneck.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WaveFrame {
    theta: f64,
    t_ms: f64,
    /// Outer index = pipe; middle index = field (0=rho, 1=u, 2=p, 3=T);
    /// inner array length == n_cells.
    pipes: Vec<[Vec<f64>; 4]>,
    cyl: Vec<CylSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CylSnapshot {
    v: f64,
    p: f64,
    t: f64,
    x_b: f64,
}

/// JSONL frame writer. Implements `CycleObserver`; you instantiate one
/// per RPM, attach to `advance_one_cycle`, then call
/// [`WaveFrameWriter::finalize`] when the cycle ends to flush the
/// manifest.
pub struct WaveFrameWriter {
    writer: Option<BufWriter<File>>,
    waves_path: PathBuf,
    manifest_path: PathBuf,
    step_idx: u64,
    step_stride: u64,
    frame_count: u64,
    t_accum_s: f64,
    job_id: String,
    rpm: f64,
    n_pipes: usize,
    pipes_meta: Vec<WavePipeMeta>,
    n_cylinders: usize,
    theta_start_deg: f64,
    theta_end_deg: f64,
    incomplete: bool,
}

impl WaveFrameWriter {
    /// Create a writer that emits to `<dir>/waves.jsonl` and finalizes a
    /// `<dir>/manifest.json` sibling. `step_stride = 1` writes every
    /// step; larger values skip steps in between.
    pub fn create(
        dir: &Path,
        job_id: String,
        eng: &SDM26Engine,
        rpm: f64,
        step_stride: u64,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let waves_path = dir.join("waves.jsonl");
        let manifest_path = dir.join("manifest.json");
        let file = OpenOptions::new()
            .write(true).create(true).truncate(true)
            .open(&waves_path)?;
        let writer = BufWriter::new(file);

        let mut pipes_meta: Vec<WavePipeMeta> = Vec::with_capacity(eng.pipes.len());
        let n_cyl = eng.cfg.n_cylinders;
        let mut role_at: Vec<(super::profiles::PipeRole, String)> = (0..eng.pipes.len())
            .map(|_| (super::profiles::PipeRole::Plenum, String::new()))
            .collect();
        role_at[eng.plenum_idx] = (super::profiles::PipeRole::Plenum, "plenum".to_string());
        for (i, &idx) in eng.runner_idx.iter().enumerate() {
            role_at[idx] = (super::profiles::PipeRole::Runner, format!("runner_{}", i + 1));
        }
        for (i, &idx) in eng.primary_idx.iter().enumerate() {
            role_at[idx] = (super::profiles::PipeRole::Primary, format!("primary_{}", i + 1));
        }
        for (i, &idx) in eng.secondary_idx.iter().enumerate() {
            role_at[idx] = (super::profiles::PipeRole::Secondary, format!("secondary_{}", i + 1));
        }
        role_at[eng.collector_idx] = (super::profiles::PipeRole::Collector, "collector".to_string());
        let _ = n_cyl;

        for (idx, pipe) in eng.pipes.iter().enumerate() {
            pipes_meta.push(WavePipeMeta {
                role: role_at[idx].0,
                label: role_at[idx].1.clone(),
                n_cells: pipe.n_cells,
                length_m: pipe.dx * (pipe.n_cells as f64),
                index: idx,
            });
        }

        Ok(Self {
            writer: Some(writer),
            waves_path,
            manifest_path,
            step_idx: 0,
            step_stride: step_stride.max(1),
            frame_count: 0,
            t_accum_s: 0.0,
            job_id,
            rpm,
            n_pipes: eng.pipes.len(),
            pipes_meta,
            n_cylinders: eng.cylinders.len(),
            theta_start_deg: f64::NAN,
            theta_end_deg: f64::NAN,
            incomplete: false,
        })
    }

    /// Flush and write the manifest. Returns the materialized manifest
    /// so callers can attach it to the SweepPoint / SingleRpm summary.
    pub fn finalize(mut self, captured_cycle: i64) -> std::io::Result<WaveFrameManifest> {
        if let Some(mut w) = self.writer.take() {
            // Best-effort flush; if it fails mark the manifest incomplete.
            if w.flush().is_err() { self.incomplete = true; }
            drop(w);
        }
        let manifest = WaveFrameManifest {
            job_id: self.job_id,
            rpm: self.rpm,
            n_pipes: self.n_pipes,
            pipes: self.pipes_meta,
            n_cylinders: self.n_cylinders,
            step_stride: self.step_stride,
            fields: vec!["rho".into(), "u".into(), "p".into(), "T".into()],
            frame_count: self.frame_count,
            theta_start_deg: if self.theta_start_deg.is_nan() { 0.0 } else { self.theta_start_deg },
            theta_end_deg: if self.theta_end_deg.is_nan() { 0.0 } else { self.theta_end_deg },
            captured_cycle,
            incomplete: self.incomplete,
        };
        let json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(&self.manifest_path, json)?;
        let _ = self.waves_path; // path kept for debugging
        Ok(manifest)
    }
}

impl CycleObserver for WaveFrameWriter {
    fn on_step(&mut self, theta_global_deg: f64, dt: f64, eng: &SDM26Engine) {
        self.t_accum_s += dt;
        self.step_idx += 1;
        if self.step_idx % self.step_stride != 0 {
            return;
        }
        if self.theta_start_deg.is_nan() { self.theta_start_deg = theta_global_deg; }
        self.theta_end_deg = theta_global_deg;
        // Build a frame.
        let mut pipes: Vec<[Vec<f64>; 4]> = Vec::with_capacity(eng.pipes.len());
        for pipe in eng.pipes.iter() {
            let n = pipe.n_cells;
            let mut rho = Vec::with_capacity(n);
            let mut u = Vec::with_capacity(n);
            let mut p = Vec::with_capacity(n);
            let mut t = Vec::with_capacity(n);
            for i in 0..n {
                let (r, vel, pr, _y) = primitives_from_cell(pipe, pipe.n_ghost + i);
                rho.push(r);
                u.push(vel);
                p.push(pr);
                t.push(if r > 0.0 { pr / (r * pipe.r_gas) } else { 0.0 });
            }
            pipes.push([rho, u, p, t]);
        }
        let cyl = eng.cylinders.iter().map(|c| {
            let theta_local = c.local_theta(theta_global_deg);
            CylSnapshot {
                v: c.volume(theta_local),
                p: c.state.p,
                t: c.state.t,
                x_b: c.state.x_b,
            }
        }).collect();
        let frame = WaveFrame {
            theta: theta_global_deg,
            t_ms: self.t_accum_s * 1000.0,
            pipes,
            cyl,
        };
        let res = (|| -> std::io::Result<()> {
            if let Some(w) = self.writer.as_mut() {
                serde_json::to_writer(&mut *w, &frame)?;
                w.write_all(b"\n")?;
            }
            Ok(())
        })();
        if res.is_err() {
            // Stop writing on first error to avoid spamming.
            self.incomplete = true;
            self.writer = None;
        } else {
            self.frame_count += 1;
        }
    }
}

/// Choose a step_stride such that the captured frame count for one
/// cycle is close to `target_frames`. Caller passes in the step count
/// of a previous cycle.
pub(crate) fn pick_stride(prev_cycle_step_count: u64, target_frames: u64) -> u64 {
    if target_frames == 0 { return 1; }
    let s = prev_cycle_step_count.saturating_div(target_frames).max(1);
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_sim::config::loader::load_v1_json;
    use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine};
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;

    fn sdm26_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json")
    }

    #[test]
    fn writes_and_finalizes_a_consistent_manifest() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cfg = load_v1_json(sdm26_path()).expect("load sdm26");
        let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
        let writer = WaveFrameWriter::create(
            tmp.path(),
            "test-job".into(),
            &eng,
            8000.0,
            200,
        ).expect("create writer");
        let mut writer = writer;
        let mut state = CycleLoopState::new(&mut eng);
        {
            let obs: &mut dyn CycleObserver = &mut writer;
            match eng.advance_one_cycle(8000.0, &mut state, None, Some(obs), None) {
                CycleOutcome::Cycle(_) => {}
                CycleOutcome::TargetReached => panic!("unexpected"),
                CycleOutcome::Cancelled => unreachable!("test passed None cancel"),
            }
        }
        let manifest = writer.finalize(1).expect("finalize");
        assert_eq!(manifest.n_pipes, eng.pipes.len());
        assert!(manifest.frame_count > 0, "no frames written");
        assert!(!manifest.incomplete);
        // Re-read from disk and confirm line count == frame_count.
        let waves = tmp.path().join("waves.jsonl");
        let f = std::fs::File::open(&waves).expect("open jsonl");
        let line_count = BufReader::new(f).lines().count() as u64;
        assert_eq!(line_count, manifest.frame_count, "jsonl line count != manifest.frame_count");
        // manifest.json must parse back.
        let mtxt = std::fs::read_to_string(tmp.path().join("manifest.json")).unwrap();
        let _back: WaveFrameManifest = serde_json::from_str(&mtxt).expect("manifest reparse");
    }
}
