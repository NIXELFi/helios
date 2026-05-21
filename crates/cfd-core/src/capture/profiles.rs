//! End-of-cycle pipe profile recorder.
//!
//! Snapshots every pipe's primitive arrays (ρ, u, p, T) along the real
//! cell centers after the converged cycle finishes. The frontend uses
//! these to render per-pipe profile plots (one panel per pipe, four
//! traces showing how each field varies along the pipe axis).
//!
//! Unlike PvLoopRecorder this is a pull-based snapshot, not a
//! CycleObserver — the engine state at the END of the cycle is the
//! only thing we need, not a stream of samples.

use engine_sim::model::sdm26::{ExhaustTopology, SDM26Engine};
use engine_sim::solver::state::{primitives_from_cell, PipeState};
use serde::{Deserialize, Serialize};

/// Per-pipe role label. Lets the frontend group plots and pick colors.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PipeRole {
    Plenum,
    Runner,
    Primary,
    Secondary,
    Collector,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeProfile {
    pub role: PipeRole,
    pub label: String,
    pub length_m: f64,
    /// Cell-center x positions in meters (length == n_cells).
    pub x_m: Vec<f64>,
    pub rho: Vec<f64>,
    pub u: Vec<f64>,
    pub p: Vec<f64>,
    pub t: Vec<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct PipeProfileRecorder {
    pub profiles: Vec<PipeProfile>,
}

impl PipeProfileRecorder {
    pub fn new() -> Self { Self::default() }

    /// Snapshot every pipe in `eng` and store the result. Idempotent —
    /// calling twice overwrites the previous snapshot. Intended to be
    /// called once at the end of the capture cycle.
    pub fn snapshot_from(&mut self, eng: &SDM26Engine) {
        let mut profiles: Vec<PipeProfile> = Vec::with_capacity(eng.pipes.len());

        // We walk pipes in index order; role + label come from the
        // engine's role-index slots so the snapshot stays in topological
        // order: plenum → runners → primaries → secondaries → collector.
        let n_cyl = eng.cfg.n_cylinders;
        // Slot lookup tables: pipe_index -> (role, label).
        let mut role_at: Vec<(PipeRole, String)> = (0..eng.pipes.len())
            .map(|_| (PipeRole::Plenum, String::new()))
            .collect();
        role_at[eng.plenum_idx] = (PipeRole::Plenum, "plenum".to_string());
        for (i, &idx) in eng.runner_idx.iter().enumerate() {
            role_at[idx] = (PipeRole::Runner, format!("runner_{}", i + 1));
        }
        for (i, &idx) in eng.primary_idx.iter().enumerate() {
            role_at[idx] = (PipeRole::Primary, format!("primary_{}", i + 1));
        }
        for (i, &idx) in eng.secondary_idx.iter().enumerate() {
            role_at[idx] = (PipeRole::Secondary, format!("secondary_{}", i + 1));
        }
        role_at[eng.collector_idx] = (PipeRole::Collector, "collector".to_string());

        // n_cyl is captured for documentation; we leave it as a hint.
        let _ = n_cyl;
        let _ = ExhaustTopology::FourTwoOne;

        for (idx, pipe) in eng.pipes.iter().enumerate() {
            profiles.push(profile_from_pipe(pipe, role_at[idx].0, role_at[idx].1.clone()));
        }

        self.profiles = profiles;
    }

    pub fn into_artifact(self) -> PipeProfileArtifact {
        PipeProfileArtifact { profiles: self.profiles }
    }
}

fn profile_from_pipe(pipe: &PipeState, role: PipeRole, label: String) -> PipeProfile {
    let n = pipe.n_cells;
    let mut x_m = Vec::with_capacity(n);
    let mut rho = Vec::with_capacity(n);
    let mut u = Vec::with_capacity(n);
    let mut p = Vec::with_capacity(n);
    let mut t = Vec::with_capacity(n);
    let r_gas = pipe.r_gas;
    for i in 0..n {
        let cell = pipe.n_ghost + i;
        let x = ((i as f64) + 0.5) * pipe.dx;
        let (r, vel, pr, _y) = primitives_from_cell(pipe, cell);
        x_m.push(x);
        rho.push(r);
        u.push(vel);
        p.push(pr);
        // T = p / (rho * R) — same convention as the Python diagnostics.
        t.push(if r > 0.0 { pr / (r * r_gas) } else { 0.0 });
    }
    PipeProfile {
        role,
        label,
        length_m: pipe.dx * (n as f64),
        x_m, rho, u, p, t,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeProfileArtifact {
    pub profiles: Vec<PipeProfile>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_sim::config::loader::load_v1_json;
    use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine};
    use std::path::PathBuf;

    fn sdm26_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json")
    }

    #[test]
    fn snapshot_yields_one_profile_per_pipe_with_real_cell_count() {
        let cfg = load_v1_json(sdm26_path()).expect("load sdm26");
        let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
        let n_pipes = eng.pipes.len();
        // Run one cycle so the state isn't trivially uniform.
        let mut state = CycleLoopState::new(&mut eng);
        match eng.advance_one_cycle(8000.0, &mut state, None, None) {
            CycleOutcome::Cycle(_) => {}
            CycleOutcome::TargetReached => panic!("unexpected target reached"),
        }

        let mut rec = PipeProfileRecorder::new();
        rec.snapshot_from(&eng);
        assert_eq!(rec.profiles.len(), n_pipes);
        for prof in &rec.profiles {
            let n_cells = prof.x_m.len();
            assert_eq!(prof.rho.len(), n_cells);
            assert_eq!(prof.u.len(), n_cells);
            assert_eq!(prof.p.len(), n_cells);
            assert_eq!(prof.t.len(), n_cells);
            assert!(n_cells > 0);
            // Pressure must remain physical (above absolute zero proxy).
            for &pr in &prof.p {
                assert!(pr > 1.0, "non-physical pressure {pr} in {}", prof.label);
            }
            // Density positive.
            for &r in &prof.rho {
                assert!(r > 0.0, "non-positive density in {}", prof.label);
            }
        }
        // Topology check: exactly one plenum + one collector.
        let n_plenum = rec.profiles.iter().filter(|p| p.role == PipeRole::Plenum).count();
        let n_collector = rec.profiles.iter().filter(|p| p.role == PipeRole::Collector).count();
        assert_eq!(n_plenum, 1);
        assert_eq!(n_collector, 1);
    }
}
