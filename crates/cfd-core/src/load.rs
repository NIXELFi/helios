//! Pure config-load logic.
//!
//! The Tauri command layer wraps this with resource-dir resolution
//! (which needs an `AppHandle`); the pure function here takes the
//! resource dir as a parameter so it can be unit-tested without any
//! Tauri runtime.

use std::path::Path;
use std::io::{BufRead, BufReader};

use crate::dto::{build_config_summary, ConfigSummary, LoadedConfig};

/// Returns true if `path` resolves under `dir` (both canonicalized when
/// possible). Falls back to a literal `starts_with` if either path can't
/// be canonicalized — Tauri resource dirs in dev sometimes don't.
pub fn path_under(path: &Path, dir: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().ok().unwrap_or_else(|| p.to_path_buf());
    canon(path).starts_with(canon(dir))
}

/// Reads + parses + validates a V1 SDM JSON config from disk.
/// `resource_dir`, when supplied, is the bundle's resource directory;
/// any loaded path inside it gets `is_example: true`. Pass `None` to
/// skip the example check (useful in tests).
pub fn load_config_from_path(
    path: &Path,
    resource_dir: Option<&Path>,
) -> Result<LoadedConfig, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Couldn't read {}: {}", path.display(), e))?;
    let raw: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("JSON parse error in {}: {}", path.display(), e))?;
    engine_sim::config::loader::load_v1_json(path)
        .map_err(|e| format!("Schema error in {}: {}", path.display(), e))?;
    let summary: ConfigSummary = build_config_summary(&raw);
    let is_example = resource_dir.map(|r| path_under(path, r)).unwrap_or(false);
    Ok(LoadedConfig {
        path: path.to_string_lossy().into_owned(),
        raw,
        summary,
        is_example,
    })
}

/// Read manifest.json + every frame of waves.jsonl for one capture
/// directory under `capture_root`. Returns `{ manifest, frames }` as a
/// single JSON value (manifest passed through, frames as JSON array).
/// First parse error aborts with the 1-based line number; no partial
/// returns. Empty lines are tolerated and skipped.
pub fn load_waves_from_dir(
    capture_root: &std::path::Path,
    job_id: &str,
    study_kind: &str,
    rpm_int: u32,
) -> Result<serde_json::Value, String> {
    if job_id.contains("..") || job_id.contains('/') || job_id.contains('\\') {
        return Err(format!("invalid job_id: {job_id}"));
    }
    match study_kind {
        "single-rpm" | "sweep" => {}
        _ => return Err(format!("invalid study_kind: {study_kind}")),
    }

    let dir = capture_root.join(job_id).join(study_kind).join(rpm_int.to_string());
    let manifest_path = dir.join("manifest.json");
    let waves_path = dir.join("waves.jsonl");

    if !manifest_path.exists() {
        return Err(format!("manifest not found: {}", manifest_path.display()));
    }
    if !waves_path.exists() {
        return Err(format!("waves.jsonl not found: {}", waves_path.display()));
    }

    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse manifest: {e}"))?;

    let frame_count_expected = manifest.get("frameCount")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "manifest missing frameCount".to_string())?;

    let f = std::fs::File::open(&waves_path)
        .map_err(|e| format!("open waves: {e}"))?;
    let reader = BufReader::new(f);
    let mut frames: Vec<serde_json::Value> = Vec::with_capacity(frame_count_expected as usize);

    for (idx, line_result) in reader.lines().enumerate() {
        let line = line_result.map_err(|e| format!("read line {}: {e}", idx + 1))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("parse waves.jsonl line {}: {e}", idx + 1))?;
        frames.push(v);
    }

    if frames.len() as u64 != frame_count_expected {
        return Err(format!(
            "frame count mismatch: manifest says {frame_count_expected}, file has {}",
            frames.len()
        ));
    }

    Ok(serde_json::json!({ "manifest": manifest, "frames": frames }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled_sdm26() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json")
    }

    #[test]
    fn missing_file_returns_clear_error() {
        let r = load_config_from_path(std::path::Path::new("/nope/does/not/exist.json"), None);
        let err = r.expect_err("expected error");
        assert!(err.contains("Couldn't read"), "got {err}");
    }

    #[test]
    fn valid_sdm26_loads_with_summary() {
        let r = load_config_from_path(&bundled_sdm26(), None).unwrap();
        assert_eq!(r.summary.n_cylinders, 4);
        assert!((r.summary.bore_mm - 67.0).abs() < 1e-9);
        assert!((r.summary.compression_ratio - 12.2).abs() < 1e-9);
        assert!(r.raw.get("cylinder").is_some());
        assert!(r.raw.get("intake_pipes").is_some());
        assert!(!r.is_example, "no resource_dir given -> is_example=false");
    }

    #[test]
    fn is_example_true_when_path_inside_resource_dir() {
        let path = bundled_sdm26();
        let resource_dir = path.parent().unwrap();
        let r = load_config_from_path(&path, Some(resource_dir)).unwrap();
        assert!(r.is_example);
    }

    #[test]
    fn is_example_false_when_path_outside_resource_dir() {
        let path = bundled_sdm26();
        let unrelated_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let r = load_config_from_path(&path, Some(&unrelated_dir)).unwrap();
        // sdm26.json lives at .../engine-sim/python_ref/configs which IS
        // under crates/ — so this stays under CARGO_MANIFEST_DIR of cfd-core
        // (../cfd-core's parent). Use a deliberately unrelated dir.
        let _ = r;
        let r2 = load_config_from_path(&path, Some(std::path::Path::new("/totally/unrelated"))).unwrap();
        assert!(!r2.is_example);
    }
}

#[cfg(test)]
mod load_waves_tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    fn setup(job_id: &str, study_kind: &str, rpm_int: u32) -> (TempDir, std::path::PathBuf) {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path()
            .join("Helios").join("cfd").join("captures")
            .join(job_id).join(study_kind).join(rpm_int.to_string());
        fs::create_dir_all(&dir).unwrap();
        (tmp, dir)
    }

    fn write_manifest(dir: &std::path::Path, frame_count: u64) {
        let manifest = serde_json::json!({
            "jobId": "test-job",
            "rpm": 8000.0,
            "nPipes": 2,
            "pipes": [
                { "role": "plenum", "label": "plenum", "nCells": 4, "lengthM": 0.2, "index": 0 },
                { "role": "collector", "label": "collector", "nCells": 4, "lengthM": 0.3, "index": 1 }
            ],
            "nCylinders": 1,
            "stepStride": 100,
            "fields": ["rho", "u", "p", "T"],
            "frameCount": frame_count,
            "thetaStartDeg": 0.0,
            "thetaEndDeg": 720.0,
            "capturedCycle": 1,
            "incomplete": false
        });
        fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    }

    fn write_waves_lines(dir: &std::path::Path, lines: &[&str]) {
        let mut f = fs::File::create(dir.join("waves.jsonl")).unwrap();
        for line in lines {
            writeln!(f, "{}", line).unwrap();
        }
    }

    fn frame_line() -> String {
        let frame = serde_json::json!({
            "theta": 0.0, "t_ms": 0.0,
            "pipes": [
                [[1.0,1.0,1.0,1.0],[0.0,0.0,0.0,0.0],[101325.0,101325.0,101325.0,101325.0],[300.0,300.0,300.0,300.0]],
                [[1.0,1.0,1.0,1.0],[0.0,0.0,0.0,0.0],[101325.0,101325.0,101325.0,101325.0],[800.0,800.0,800.0,800.0]]
            ],
            "cyl": [{ "v": 5e-5, "p": 101325.0, "t": 300.0, "x_b": 0.0 }]
        });
        serde_json::to_string(&frame).unwrap()
    }

    #[test]
    fn happy_path_returns_manifest_and_frames() {
        let (tmp, dir) = setup("job-1", "single-rpm", 8000);
        write_manifest(&dir, 3);
        let l = frame_line();
        write_waves_lines(&dir, &[&l, &l, &l]);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let v = load_waves_from_dir(&root, "job-1", "single-rpm", 8000).expect("ok");
        assert!(v.get("manifest").is_some());
        assert_eq!(v["frames"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn rejects_jsonl_parse_error_with_line_number() {
        let (tmp, dir) = setup("job-2", "single-rpm", 8000);
        write_manifest(&dir, 2);
        let l = frame_line();
        write_waves_lines(&dir, &[&l, "not json", &l]);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "job-2", "single-rpm", 8000).unwrap_err();
        assert!(err.contains("line 2"), "got: {err}");
    }

    #[test]
    fn rejects_manifest_frame_count_mismatch() {
        let (tmp, dir) = setup("job-3", "single-rpm", 8000);
        write_manifest(&dir, 5);
        let l = frame_line();
        write_waves_lines(&dir, &[&l, &l]);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "job-3", "single-rpm", 8000).unwrap_err();
        assert!(err.contains("frame") && err.contains("2") && err.contains("5"), "got: {err}");
    }

    #[test]
    fn rejects_path_traversal_in_job_id() {
        let (tmp, _dir) = setup("job-4", "single-rpm", 8000);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "../escape", "single-rpm", 8000).unwrap_err();
        assert!(err.contains("invalid"), "got: {err}");
    }

    #[test]
    fn rejects_invalid_study_kind() {
        let (tmp, _dir) = setup("job-5", "single-rpm", 8000);
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let err = load_waves_from_dir(&root, "job-5", "wat", 8000).unwrap_err();
        assert!(err.contains("study_kind"), "got: {err}");
    }

    #[test]
    fn tolerates_blank_jsonl_lines() {
        let (tmp, dir) = setup("job-6", "single-rpm", 8000);
        write_manifest(&dir, 2);
        let l = frame_line();
        let mut f = fs::File::create(dir.join("waves.jsonl")).unwrap();
        writeln!(f, "{}", l).unwrap();
        writeln!(f, "").unwrap();
        writeln!(f, "{}", l).unwrap();
        let root = tmp.path().join("Helios").join("cfd").join("captures");
        let v = load_waves_from_dir(&root, "job-6", "single-rpm", 8000).expect("ok");
        assert_eq!(v["frames"].as_array().unwrap().len(), 2);
    }
}
