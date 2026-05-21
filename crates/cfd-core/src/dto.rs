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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SingleRpmParams {
    pub rpm: f64,
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
    // Sweep { ... }           // Phase 3
    // Optimization { ... }    // Phase 5
}

impl StartJobRequest {
    pub fn kind(&self) -> StudyKind {
        match self {
            StartJobRequest::SingleRpm { .. } => StudyKind::SingleRpm,
        }
    }
    pub fn config_path(&self) -> &str {
        match self {
            StartJobRequest::SingleRpm { config_path, .. } => config_path,
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
pub struct JobProgressEvent {
    pub job_id: String,
    pub kind: StudyKind,
    pub payload: JobProgressSingleRpm,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleRpmDoneSummary {
    pub converged_cycle: i64,
    pub n_cycles_run: u32,
    pub step_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDoneEvent {
    pub job_id: String,
    pub kind: StudyKind,
    pub payload: SingleRpmDoneSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancelledEvent {
    pub job_id: String,
    pub partial_cycles: Vec<engine_sim::model::sdm26::CycleStats>,
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
    pub reason: ErrorReason,
    pub message: String,
    pub partial_cycles: Vec<engine_sim::model::sdm26::CycleStats>,
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
    fn single_rpm_request_serde_roundtrip() {
        let req = StartJobRequest::SingleRpm {
            config_path: "C:/x/sdm26.json".into(),
            params: SingleRpmParams {
                rpm: 6000.0,
                n_cycles_max: 25,
                junction_kind: JunctionKindDto::Stagnation,
                convergence_tol_imep: 1e-3,
                convergence_min_cycles: 5,
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        // Verify camelCase + kebab-case
        assert!(json.contains("\"kind\":\"single-rpm\""), "{json}");
        assert!(json.contains("\"junctionKind\":\"stagnation\""), "{json}");
        assert!(json.contains("\"nCyclesMax\":25"), "{json}");
        assert!(json.contains("\"convergenceTolImep\":0.001"), "{json}");
        let back: StartJobRequest = serde_json::from_str(&json).unwrap();
        match (&req, &back) {
            (
                StartJobRequest::SingleRpm { config_path: cp1, params: p1 },
                StartJobRequest::SingleRpm { config_path: cp2, params: p2 },
            ) => {
                assert_eq!(cp1, cp2);
                assert_eq!(p1, p2);
            }
        }
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
