//! Serde DTOs that cross the Tauri → frontend boundary.
//!
//! Casing convention: structs use `rename_all = "camelCase"`, enums use
//! `rename_all = "kebab-case"`. Field-by-field deviations are spelled
//! out via `#[serde(rename = "...")]` only when natural English casing
//! diverges (e.g. acronyms `IMEP`, `RPM`).

use engine_sim::model::sdm26::JunctionKind as EsJunctionKind;
use serde::{Deserialize, Serialize};

// ---------------- Config loading ----------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConfig {
    pub path: String,
    /// Raw JSON from disk so the frontend can render any field of the
    /// V1 schema without a Rust-side mirror. Phase 2's editor will work
    /// from this same shape.
    pub raw: serde_json::Value,
    pub summary: ConfigSummary,
    /// True when `path` resolves under the bundled resource directory.
    /// The frontend uses this to redirect Save → Save-As so bundled
    /// examples can't be overwritten in place. Defense-in-depth check
    /// also runs Rust-side in `cfd_save_config`.
    pub is_example: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSummary {
    pub display_name: String,
    pub n_cylinders: u32,
    pub bore_mm: f64,
    pub stroke_mm: f64,
    pub compression_ratio: f64,
    pub displacement_l: f64,
    pub restrictor_throat_mm: f64,
    pub plenum_volume_l: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
}

// ---------------- Job request / response ----------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JunctionKindDto {
    Stagnation,
    Characteristic,
}

impl From<JunctionKindDto> for EsJunctionKind {
    fn from(k: JunctionKindDto) -> Self {
        match k {
            JunctionKindDto::Stagnation => EsJunctionKind::Stagnation,
            JunctionKindDto::Characteristic => EsJunctionKind::Characteristic,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SingleRpmParams {
    pub rpm: f64,
    pub n_cycles_max: u32,
    pub junction_kind: JunctionKindDto,
    #[serde(rename = "convergenceTolImep")]
    pub convergence_tol_imep: f64,
    pub convergence_min_cycles: u32,
    /// Phase 3 capture flags. Default to "off, on, on" — wave capture
    /// is opt-in (disk-heavy), but the inexpensive P-V + profile
    /// snapshots default on so per-RPM exploration "just works".
    #[serde(default)]
    pub capture_waves: bool,
    #[serde(default = "default_capture_pv")]
    pub capture_pv_loops: bool,
    #[serde(default = "default_capture_pv")]
    pub capture_pipe_profiles: bool,
}

fn default_capture_pv() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SweepParams {
    pub rpm_list: Vec<f64>,
    pub n_cycles_max: u32,
    pub junction_kind: JunctionKindDto,
    #[serde(rename = "convergenceTolImep")]
    pub convergence_tol_imep: f64,
    pub convergence_min_cycles: u32,
    #[serde(default)]
    pub capture_waves: bool,
    #[serde(default = "default_capture_pv")]
    pub capture_pv_loops: bool,
    #[serde(default = "default_capture_pv")]
    pub capture_pipe_profiles: bool,
}

// ---------------- Optimization parameter / objective DTOs (Phase 5) ----------------

/// How to reduce a per-RPM metric vector to a single scalar.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ObjectiveAggregator {
    /// Maximum value of `metric` across the RPM list.
    Max,
    /// Minimum value of `metric` across the RPM list.
    Min,
    /// Arithmetic mean across the RPM list.
    Mean,
    /// Trapezoidal area-under-curve (metric vs. rpm).
    Auc,
    /// Value at a specific RPM (must exist in the RPM list).
    AtRpm {
        #[serde(rename = "rpmInt")]
        rpm_int: u32,
    },
    /// Sum across the RPM list.
    Sum,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectiveDirection {
    Maximize,
    Minimize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveSpec {
    /// One of the CycleStats field names in snake_case
    /// (e.g. "imep_bar", "ve_atm", "indicated_power_k_w").
    pub metric: String,
    pub aggregator: ObjectiveAggregator,
    pub rpm_list: Vec<f64>,
    pub direction: ObjectiveDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParameterBounds {
    /// Path into SDM26Config, e.g. "p_ambient", "restrictor_throat_diameter",
    /// "runner_length", "runner_lengths[0]". Names are the flat SDM26Config
    /// field names (see `crates/engine-sim/src/model/sdm26.rs`).
    pub path: String,
    pub min: f64,
    pub max: f64,
    /// Step size for snap-to-grid (None = continuous).
    #[serde(default)]
    pub step: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SamplerKind {
    Lhs,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationParams {
    pub tunables: Vec<ParameterBounds>,
    pub objective: ObjectiveSpec,
    pub n_trials: u32,
    pub sampler: SamplerKind,
    #[serde(default)]
    pub seed: Option<u64>,
    pub n_cycles_max: u32,
    pub junction_kind: JunctionKindDto,
    #[serde(rename = "convergenceTolImep")]
    pub convergence_tol_imep: f64,
    pub convergence_min_cycles: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StartJobRequest {
    SingleRpm {
        #[serde(rename = "configPath")]
        config_path: String,
        params: SingleRpmParams,
    },
    Sweep {
        #[serde(rename = "configPath")]
        config_path: String,
        params: SweepParams,
    },
    Optimization {
        #[serde(rename = "configPath")]
        config_path: String,
        params: OptimizationParams,
    },
}

impl StartJobRequest {
    pub fn kind(&self) -> StudyKind {
        match self {
            StartJobRequest::SingleRpm { .. } => StudyKind::SingleRpm,
            StartJobRequest::Sweep { .. } => StudyKind::Sweep,
            StartJobRequest::Optimization { .. } => StudyKind::Optimization,
        }
    }
    pub fn config_path(&self) -> &str {
        match self {
            StartJobRequest::SingleRpm { config_path, .. } => config_path,
            StartJobRequest::Sweep { config_path, .. } => config_path,
            StartJobRequest::Optimization { config_path, .. } => config_path,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobResponse {
    pub job_id: String,
}

// ---------------- Job lifecycle status ----------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StudyKind {
    SingleRpm,
    Sweep,
    Optimization,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobStatus {
    Running,
    Done,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub kind: StudyKind,
    pub status: JobStatus,
    pub config_path: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

// ---------------- Event payloads ----------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStartedEvent {
    pub job_id: String,
    pub kind: StudyKind,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressSingleRpm {
    pub cycle: u32,
    pub total: u32,
    /// Single just-completed cycle's stats (camelCase via engine_sim's
    /// serde derive on CycleStats).
    pub cycle_stats: engine_sim::model::sdm26::CycleStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepPoint {
    pub rpm: f64,
    pub converged_cycle: i64,
    pub n_cycles_run: u32,
    pub last_cycle: engine_sim::model::sdm26::CycleStats,
    pub nonconservation_max: f64,
    pub wall_time_s: f64,
    pub step_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobProgressPayload {
    SingleRpm(JobProgressSingleRpm),
    #[serde(rename_all = "camelCase")]
    SweepRpmStarted {
        rpm_idx: u32,
        total_rpms: u32,
        rpm: f64,
    },
    #[serde(rename_all = "camelCase")]
    SweepCycle {
        rpm_idx: u32,
        rpm: f64,
        cycle: u32,
        total: u32,
        cycle_stats: engine_sim::model::sdm26::CycleStats,
    },
    #[serde(rename_all = "camelCase")]
    SweepRpmDone {
        rpm_idx: u32,
        rpm: f64,
        point: SweepPoint,
        capture_dir: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    OptimizationTrialStarted {
        trial_idx: u32,
        n_trials: u32,
        /// path -> physical value (already snapped to step grid).
        parameter_values: std::collections::BTreeMap<String, f64>,
    },
    #[serde(rename_all = "camelCase")]
    OptimizationTrialDone {
        trial_idx: u32,
        n_trials: u32,
        objective_value: f64,
        /// Sweep points produced by this trial — one per RPM in the
        /// objective's rpm_list.
        sweep_points: Vec<SweepPoint>,
        wall_time_s: f64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub job_id: String,
    pub kind: StudyKind,
    pub payload: JobProgressPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleRpmDoneSummary {
    pub converged_cycle: i64,
    pub n_cycles_run: u32,
    pub step_count: u64,
    /// Directory under captures/ containing pv.json / profiles.json /
    /// waves.jsonl + manifest.json for this run, when any capture was
    /// enabled. `None` if all capture flags were off.
    pub capture_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepDoneSummary {
    pub n_rpms: u32,
    pub n_completed: u32,
    pub total_step_count: u64,
    pub total_wall_time_s: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationDoneSummary {
    pub n_trials_requested: u32,
    pub n_trials_run: u32,
    pub best_trial_idx: Option<u32>,
    pub best_objective_value: Option<f64>,
    pub parameter_paths: Vec<String>,
    pub objective_direction: ObjectiveDirection,
    pub total_wall_time_s: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobDoneSummary {
    SingleRpm(SingleRpmDoneSummary),
    Sweep(SweepDoneSummary),
    Optimization(OptimizationDoneSummary),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDoneEvent {
    pub job_id: String,
    pub kind: StudyKind,
    pub payload: JobDoneSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancelledEvent {
    pub job_id: String,
    pub kind: StudyKind,
    /// Single-RPM only: cycles that ran before cancellation.
    #[serde(default)]
    pub partial_cycles: Vec<engine_sim::model::sdm26::CycleStats>,
    /// Sweep only: RPMs that completed before cancellation.
    #[serde(default)]
    pub partial_points: Vec<SweepPoint>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorReason {
    ConfigLoad,
    SolverDiverged,
    Panic,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobErrorEvent {
    pub job_id: String,
    pub kind: StudyKind,
    pub reason: ErrorReason,
    pub message: String,
    #[serde(default)]
    pub partial_cycles: Vec<engine_sim::model::sdm26::CycleStats>,
    #[serde(default)]
    pub partial_points: Vec<SweepPoint>,
}

// ---------------- Config summary builder ----------------

pub fn build_config_summary(raw: &serde_json::Value) -> ConfigSummary {
    let name = raw.get("name").and_then(|v| v.as_str()).unwrap_or("(unnamed)").to_string();
    let n_cyl = raw
        .get("n_cylinders")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let cyl = raw.get("cylinder");
    let bore = cyl
        .and_then(|c| c.get("bore"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let stroke = cyl
        .and_then(|c| c.get("stroke"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let cr = cyl
        .and_then(|c| c.get("compression_ratio"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let restr_d = raw
        .get("restrictor")
        .and_then(|r| r.get("throat_diameter"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let plen_v = raw
        .get("plenum")
        .and_then(|p| p.get("volume"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let displacement_m3 =
        std::f64::consts::PI / 4.0 * bore * bore * stroke * (n_cyl as f64);
    ConfigSummary {
        display_name: name,
        n_cylinders: n_cyl,
        bore_mm: bore * 1000.0,
        stroke_mm: stroke * 1000.0,
        compression_ratio: cr,
        displacement_l: displacement_m3 * 1000.0,
        restrictor_throat_mm: restr_d * 1000.0,
        plenum_volume_l: plen_v * 1000.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loaded_config_camel_case_includes_is_example() {
        let lc = LoadedConfig {
            path: "x".into(),
            raw: serde_json::json!({}),
            summary: ConfigSummary {
                display_name: "x".into(),
                n_cylinders: 4,
                bore_mm: 0.0,
                stroke_mm: 0.0,
                compression_ratio: 0.0,
                displacement_l: 0.0,
                restrictor_throat_mm: 0.0,
                plenum_volume_l: 0.0,
            },
            is_example: true,
        };
        let s = serde_json::to_string(&lc).unwrap();
        assert!(s.contains("\"isExample\":true"), "{s}");
    }

    #[test]
    fn single_rpm_request_serde_roundtrip() {
        let req = StartJobRequest::SingleRpm {
            config_path: "C:/x/sdm26.json".into(),
            params: SingleRpmParams {
                rpm: 6000.0,
                n_cycles_max: 25,
                junction_kind: JunctionKindDto::Stagnation,
                convergence_tol_imep: 1e-3,
                convergence_min_cycles: 5,
                capture_waves: false,
                capture_pv_loops: true,
                capture_pipe_profiles: true,
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        // Verify camelCase + kebab-case
        assert!(json.contains("\"kind\":\"single-rpm\""), "{json}");
        assert!(json.contains("\"junctionKind\":\"stagnation\""), "{json}");
        assert!(json.contains("\"nCyclesMax\":25"), "{json}");
        assert!(json.contains("\"convergenceTolImep\":0.001"), "{json}");
        assert!(json.contains("\"captureWaves\":false"), "{json}");
        assert!(json.contains("\"capturePvLoops\":true"), "{json}");
        let back: StartJobRequest = serde_json::from_str(&json).unwrap();
        match (&req, &back) {
            (
                StartJobRequest::SingleRpm { config_path: cp1, params: p1 },
                StartJobRequest::SingleRpm { config_path: cp2, params: p2 },
            ) => {
                assert_eq!(cp1, cp2);
                assert_eq!(p1, p2);
            }
            _ => panic!("variant mismatch"),
        }
    }

    #[test]
    fn sweep_request_serde_roundtrip() {
        let req = StartJobRequest::Sweep {
            config_path: "C:/x/sdm26.json".into(),
            params: SweepParams {
                rpm_list: vec![4000.0, 6000.0, 8000.0],
                n_cycles_max: 20,
                junction_kind: JunctionKindDto::Characteristic,
                convergence_tol_imep: 5e-3,
                convergence_min_cycles: 3,
                capture_waves: true,
                capture_pv_loops: true,
                capture_pipe_profiles: false,
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"kind\":\"sweep\""), "{json}");
        assert!(json.contains("\"rpmList\":[4000.0,6000.0,8000.0]"), "{json}");
        assert!(json.contains("\"captureWaves\":true"), "{json}");
        let back: StartJobRequest = serde_json::from_str(&json).unwrap();
        match (&req, &back) {
            (
                StartJobRequest::Sweep { config_path: cp1, params: p1 },
                StartJobRequest::Sweep { config_path: cp2, params: p2 },
            ) => {
                assert_eq!(cp1, cp2);
                assert_eq!(p1, p2);
            }
            _ => panic!("variant mismatch"),
        }
    }

    #[test]
    fn job_progress_payload_tagged_dispatch() {
        // SweepRpmStarted
        let p = JobProgressPayload::SweepRpmStarted { rpm_idx: 0, total_rpms: 3, rpm: 4000.0 };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"kind\":\"sweep-rpm-started\""), "{s}");
        assert!(s.contains("\"rpmIdx\":0"), "{s}");
        assert!(s.contains("\"totalRpms\":3"), "{s}");
    }

    #[test]
    fn job_done_summary_tagged_dispatch() {
        let s = JobDoneSummary::Sweep(SweepDoneSummary {
            n_rpms: 5, n_completed: 5, total_step_count: 12345, total_wall_time_s: 1.23,
        });
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"kind\":\"sweep\""), "{j}");
        assert!(j.contains("\"nRpms\":5"), "{j}");
    }

    #[test]
    fn junction_kind_dto_kebab_case() {
        assert_eq!(serde_json::to_string(&JunctionKindDto::Stagnation).unwrap(), "\"stagnation\"");
        assert_eq!(serde_json::to_string(&JunctionKindDto::Characteristic).unwrap(), "\"characteristic\"");
        let s: JunctionKindDto = serde_json::from_str("\"stagnation\"").unwrap();
        assert_eq!(s, JunctionKindDto::Stagnation);
    }

    #[test]
    fn job_status_kebab_case() {
        for v in [JobStatus::Running, JobStatus::Done, JobStatus::Cancelled, JobStatus::Error] {
            let s = serde_json::to_string(&v).unwrap();
            let back: JobStatus = serde_json::from_str(&s).unwrap();
            assert_eq!(v, back);
        }
        assert_eq!(serde_json::to_string(&JobStatus::Cancelled).unwrap(), "\"cancelled\"");
    }

    #[test]
    fn error_reason_kebab_case() {
        assert_eq!(serde_json::to_string(&ErrorReason::SolverDiverged).unwrap(), "\"solver-diverged\"");
        assert_eq!(serde_json::to_string(&ErrorReason::ConfigLoad).unwrap(), "\"config-load\"");
    }

    #[test]
    fn config_summary_from_sdm26_raw() {
        let raw: serde_json::Value = serde_json::json!({
            "name": "Honda CBR600RR (FSAE)",
            "n_cylinders": 4,
            "cylinder": {
                "bore": 0.067,
                "stroke": 0.0425,
                "compression_ratio": 12.2,
            },
            "restrictor": { "throat_diameter": 0.020 },
            "plenum": { "volume": 0.0015 },
        });
        let s = build_config_summary(&raw);
        assert_eq!(s.display_name, "Honda CBR600RR (FSAE)");
        assert_eq!(s.n_cylinders, 4);
        assert!((s.bore_mm - 67.0).abs() < 1e-9);
        assert!((s.stroke_mm - 42.5).abs() < 1e-9);
        assert!((s.compression_ratio - 12.2).abs() < 1e-12);
        assert!((s.restrictor_throat_mm - 20.0).abs() < 1e-9);
        assert!((s.plenum_volume_l - 1.5).abs() < 1e-9);
        // displacement = pi/4 * 0.067^2 * 0.0425 * 4 = ~0.000599 m^3 = 0.599 L
        assert!((s.displacement_l - 0.5993).abs() < 1e-3);
    }
}
