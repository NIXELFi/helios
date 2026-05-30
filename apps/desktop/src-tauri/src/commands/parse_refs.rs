//! Parse a SolidWorks file's child references (path hints) from disk.
//!
//! Wraps the `pdm-sw-parser` crate so the Vault client can extract assembly →
//! part / drawing → model references at check-in time, then persist them via
//! the `pdm_record_refs` RPC. Best-effort: unreadable / non-CFB files yield an
//! empty list rather than an error, so a parse miss never blocks a check-in. A
//! read failure (path gone) IS surfaced so the caller can log it.

use std::fs;

/// Read `path` and return the referenced part/sub-assembly/model path hints
/// found inside (raw strings as they appear in the SW file — resolution to
/// vault files happens server-side in `pdm.record_refs`).
#[tauri::command]
pub fn parse_sw_refs(path: String) -> Result<Vec<String>, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(pdm_sw_parser::parse_refs(&bytes)
        .into_iter()
        .map(|r| r.path)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn write_cfb_with_refs(payload: &[u8]) -> String {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut comp = cfb::CompoundFile::create(cursor).unwrap();
            comp.create_stream("External References").unwrap().write_all(payload).unwrap();
            comp.flush().unwrap();
        }
        let mut p = std::env::temp_dir();
        p.push(format!("helios_refs_test_{}.sldasm", std::process::id()));
        fs::write(&p, &buf).unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn returns_ref_path_hints_from_a_sw_file() {
        let mut payload: Vec<u8> = Vec::new();
        payload.extend_from_slice(b"\x00\x00..\\parts\\frame-rail.sldprt\x00");
        payload.extend_from_slice(b"junk\xff\xff..\\hardware\\m6-bolt.sldprt\x00");
        let path = write_cfb_with_refs(&payload);

        let refs = parse_sw_refs(path.clone()).unwrap();
        assert!(refs.iter().any(|p| p.ends_with("frame-rail.sldprt")));
        assert!(refs.iter().any(|p| p.ends_with("m6-bolt.sldprt")));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn errors_on_missing_path() {
        assert!(parse_sw_refs("/nope/missing.sldasm".to_string()).is_err());
    }
}
