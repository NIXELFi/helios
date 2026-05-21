//! Pure save logic for the CFD config editor.
//!
//! Pipeline:
//!   1. Serialize the draft JSON to text (4-space indent, matching
//!      bundled examples so a `diff` between user saves and the
//!      originals is clean).
//!   2. Validate via engine-sim's V1 loader by writing the text to a
//!      temp file. If the loader rejects, surface its error verbatim
//!      and DO NOT touch the final path.
//!   3. Atomic write: write to `<path>.tmp` in the same directory,
//!      then `fs::rename` onto `path`.
//!
//! The Tauri command layer is responsible for any UI-level policy
//! (e.g. refusing to write inside the bundle's resource dir). This
//! module enforces only "is the JSON valid?" and "is the write
//! crash-safe?".

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde_json::ser::PrettyFormatter;

/// Serialize `raw` to a 4-space-indented JSON string.
fn to_pretty_4(raw: &serde_json::Value) -> Result<String, String> {
    let mut buf = Vec::new();
    let fmt = PrettyFormatter::with_indent(b"    ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    raw.serialize(&mut ser)
        .map_err(|e| format!("serialize: {e}"))?;
    String::from_utf8(buf).map_err(|e| format!("utf8: {e}"))
}

/// Validate `raw` by writing it to a temp file and running engine-sim's
/// V1 loader against it. Returns the same error text `cfd_load_config`
/// would on a bad config.
fn validate_via_loader(text: &str) -> Result<(), String> {
    let temp = tempfile::Builder::new()
        .prefix("cfd-validate-")
        .suffix(".json")
        .tempfile()
        .map_err(|e| format!("create temp: {e}"))?;
    fs::write(temp.path(), text.as_bytes())
        .map_err(|e| format!("write temp: {e}"))?;
    engine_sim::config::loader::load_v1_json(temp.path())
        .map(|_| ())
        .map_err(|e| format!("Schema error: {e}"))
}

/// Save `raw` to `path` atomically. Validation runs before any write
/// to the final path, so a failed save never produces a broken file.
pub fn save_config(path: &Path, raw: &serde_json::Value) -> Result<(), String> {
    let text = to_pretty_4(raw)?;
    validate_via_loader(&text)?;

    // Atomic write: <path>.tmp then rename. Same directory so rename
    // stays atomic on all filesystems we care about.
    let tmp_path = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("create {}: {}", tmp_path.display(), e))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("write {}: {}", tmp_path.display(), e))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp_path, path).map_err(|e| {
        // Best-effort cleanup on rename failure so we don't leave a stray .tmp.
        let _ = fs::remove_file(&tmp_path);
        format!("rename {} -> {}: {}", tmp_path.display(), path.display(), e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_sdm26() -> serde_json::Value {
        let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json");
        let text = std::fs::read_to_string(p).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn save_valid_config_writes_pretty_json_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        save_config(&target, &valid_sdm26()).expect("save succeeds");
        assert!(target.exists(), "target file must exist after save");
        assert!(
            !target.with_extension("tmp").exists(),
            ".tmp must not remain after atomic rename"
        );
        let text = std::fs::read_to_string(&target).unwrap();
        // 4-space indent at the top-level key boundary.
        assert!(
            text.contains("\n    \"cylinder\""),
            "expected 4-space indent under 'cylinder': {}",
            &text[..text.len().min(200)]
        );
    }

    #[test]
    fn save_rejects_invalid_config_with_engine_sim_error() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        let mut bad = valid_sdm26();
        bad.as_object_mut().unwrap().remove("cylinder");
        let err = save_config(&target, &bad).expect_err("must reject");
        assert!(
            err.to_lowercase().contains("cylinder"),
            "engine-sim error should mention the missing field: {err}"
        );
        assert!(
            !target.exists(),
            "the final file must not be written when validation fails"
        );
    }

    #[test]
    fn save_round_trips_through_loader_field_for_field() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        let raw = valid_sdm26();
        save_config(&target, &raw).unwrap();
        // Reload and confirm the cylinder.bore made it through unchanged.
        let reloaded: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        let want_bore = raw.get("cylinder").unwrap().get("bore").unwrap().as_f64().unwrap();
        let got_bore = reloaded.get("cylinder").unwrap().get("bore").unwrap().as_f64().unwrap();
        assert!((got_bore - want_bore).abs() < 1e-15);
    }

    #[test]
    fn save_does_not_overwrite_on_validation_failure() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("existing.json");
        // Pre-write a sentinel.
        std::fs::write(&target, b"SENTINEL").unwrap();
        let mut bad = valid_sdm26();
        bad.as_object_mut().unwrap().remove("cylinder");
        assert!(save_config(&target, &bad).is_err());
        // Sentinel preserved.
        let after = std::fs::read_to_string(&target).unwrap();
        assert_eq!(after, "SENTINEL");
    }
}
