//! Per-cylinder P-V + crank-angle trace recorder.
//!
//! Captures (theta_local_deg, V, p, T, x_b) for every cylinder once per
//! internal solver step throughout one cycle. The frontend uses these
//! arrays to render P-V loops + p(θ) / T(θ) / x_b(θ) trace panels.

use engine_sim::model::sdm26::{CycleObserver, SDM26Engine};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PvSample {
    pub theta_local_deg: f64,
    pub volume: f64,
    pub pressure: f64,
    pub temperature: f64,
    pub x_b: f64,
}

#[derive(Debug)]
pub struct PvLoopRecorder {
    /// One Vec per cylinder. Pre-allocated up to the expected step count
    /// for one cycle (~10k); excess is fine — Vec::push amortizes.
    samples: Vec<Vec<PvSample>>,
}

impl PvLoopRecorder {
    pub fn new(n_cylinders: usize) -> Self {
        Self {
            samples: (0..n_cylinders)
                .map(|_| Vec::with_capacity(16_384))
                .collect(),
        }
    }

    pub fn into_artifact(self) -> PvLoopArtifact {
        PvLoopArtifact { cylinders: self.samples }
    }
}

impl CycleObserver for PvLoopRecorder {
    fn on_step(&mut self, _theta_global_deg: f64, _dt: f64, eng: &SDM26Engine) {
        for (i, cyl) in eng.cylinders.iter().enumerate() {
            let theta_local = cyl.local_theta(_theta_global_deg);
            let v = cyl.volume(theta_local);
            self.samples[i].push(PvSample {
                theta_local_deg: theta_local,
                volume: v,
                pressure: cyl.state.p,
                temperature: cyl.state.t,
                x_b: cyl.state.x_b,
            });
        }
    }
}

/// Disk-serializable form. Written to `<capture_dir>/pv.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PvLoopArtifact {
    /// Outer index = cylinder index (0..n_cylinders).
    pub cylinders: Vec<Vec<PvSample>>,
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
    fn records_at_least_100_samples_per_cylinder_per_cycle() {
        let cfg = load_v1_json(sdm26_path()).expect("load sdm26");
        let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
        let n_cyl = eng.cylinders.len();
        let mut state = CycleLoopState::new(&mut eng);
        let mut rec = PvLoopRecorder::new(n_cyl);
        {
            let obs: &mut dyn CycleObserver = &mut rec;
            match eng.advance_one_cycle(8000.0, &mut state, None, Some(obs)) {
                CycleOutcome::Cycle(_) => {}
                CycleOutcome::TargetReached => panic!("cycle ended before completion"),
            }
        }
        let artifact = rec.into_artifact();
        assert_eq!(artifact.cylinders.len(), n_cyl);
        for (i, cyl_samples) in artifact.cylinders.iter().enumerate() {
            assert!(
                cyl_samples.len() > 100,
                "cylinder {i} captured only {} samples",
                cyl_samples.len()
            );
            // Volumes should always be positive (cylinder has non-zero
            // clearance volume).
            for s in cyl_samples {
                assert!(s.volume > 0.0, "non-positive volume: {}", s.volume);
                assert!(s.pressure > 0.0, "non-positive pressure: {}", s.pressure);
                assert!(
                    (0.0..=720.0).contains(&s.theta_local_deg),
                    "theta_local out of [0, 720): {}",
                    s.theta_local_deg
                );
            }
        }
    }
}
