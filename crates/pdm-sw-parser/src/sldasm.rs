use crate::ref_hint::RefHint;
use cfb::CompoundFile;
use std::io::{Read, Seek};
use alloc::string::String;
use alloc::vec::Vec;

const SW_EXTENSIONS: &[&str] = &[".sldprt", ".sldasm", ".slddrw"];

/// Cap per-stream reads so an adversarial CFB file with a multi-GB Reference
/// stream can't OOM the parser. 4 MiB is far above any observed SolidWorks
/// reference-metadata stream in real assemblies.
const MAX_STREAM_BYTES: u64 = 4 * 1024 * 1024;

/// Cap the number of RefHint records produced from a single stream so a stream
/// filled with synthetic extension noise can't produce unbounded allocations.
const MAX_HINTS: usize = 1024;

/// Walk the container, find streams whose name contains "reference" (case-
/// insensitive — SolidWorks streams vary in casing across versions:
/// `References`, `Reference Data`, `DLBaseTreeRef`, etc.), and scan each one
/// for printable-ASCII runs that end in a SolidWorks extension. Each match
/// becomes a RefHint.
///
/// Best-effort across SW versions — formats differ. We err on the side of
/// recall over precision; consumers dedupe by basename.
pub fn extract_refs<F: Read + Seek>(comp: &mut CompoundFile<F>) -> Vec<RefHint> {
    let candidate_streams: Vec<String> = comp
        .walk()
        .filter(|e| e.is_stream())
        .map(|e| e.path().to_string_lossy().into_owned())
        .filter(|name| name.to_ascii_lowercase().contains("reference"))
        .collect();

    let mut hints = Vec::new();
    for stream_name in candidate_streams {
        let mut buf = Vec::new();
        if let Ok(mut s) = comp.open_stream(&stream_name) {
            if (&mut s).take(MAX_STREAM_BYTES).read_to_end(&mut buf).is_ok() {
                hints.extend(scan_bytes_for_paths(&buf));
                if hints.len() >= MAX_HINTS {
                    hints.truncate(MAX_HINTS);
                    break;
                }
            }
        }
    }
    hints
}

fn scan_bytes_for_paths(bytes: &[u8]) -> Vec<RefHint> {
    // Two passes, since SW reference streams encode paths differently across
    // versions. Both cap output at MAX_HINTS to bound memory on adversarial
    // input. (1) Single-byte printable-ASCII runs (modern streams). (2)
    // UTF-16LE wide runs — every printable ASCII char followed by 0x00 — which
    // legacy CFB reference streams use; without this pass those paths yield
    // zero hints.
    let mut out = Vec::new();
    scan_ascii_runs(bytes, &mut out);
    if out.len() < MAX_HINTS {
        scan_wide_runs(bytes, &mut out);
    }
    if out.len() > MAX_HINTS {
        out.truncate(MAX_HINTS);
    }
    out
}

/// Pass 1: collect maximal runs of printable-ASCII bytes (and the path
/// separators / : drive letter), then keep each run that ends in one of the SW
/// extensions.
fn scan_ascii_runs(bytes: &[u8], out: &mut Vec<RefHint>) {
    let mut current = String::new();
    for &b in bytes {
        if is_printable(b) {
            current.push(b as char);
        } else {
            check_and_push(&mut current, out);
            current.clear();
            if out.len() >= MAX_HINTS {
                return;
            }
        }
    }
    check_and_push(&mut current, out);
}

/// Pass 2: collect maximal runs of UTF-16LE code units whose low byte is a
/// printable ASCII char and whose high byte is 0x00, decode them via
/// `String::from_utf16_lossy`, and keep any that end in a SW extension. This is
/// how legacy CFB reference streams store paths.
fn scan_wide_runs(bytes: &[u8], out: &mut Vec<RefHint>) {
    let mut units: Vec<u16> = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let (lo, hi) = (bytes[i], bytes[i + 1]);
        if hi == 0x00 && is_printable(lo) {
            units.push(lo as u16);
            i += 2;
        } else {
            flush_wide(&mut units, out);
            // Advance a single byte so we re-align on the next potential wide
            // run rather than skipping past it.
            i += 1;
            if out.len() >= MAX_HINTS {
                return;
            }
        }
    }
    flush_wide(&mut units, out);
}

fn flush_wide(units: &mut Vec<u16>, out: &mut Vec<RefHint>) {
    if units.is_empty() {
        return;
    }
    let mut run = String::from_utf16_lossy(units);
    units.clear();
    check_and_push(&mut run, out);
}

fn is_printable(b: u8) -> bool {
    (0x20..=0x7e).contains(&b)
}

fn check_and_push(run: &mut String, out: &mut Vec<RefHint>) {
    if run.is_empty() {
        return;
    }
    let lower = run.to_ascii_lowercase();
    if SW_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        out.push(RefHint { path: core::mem::take(run) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_bytes_for_paths_caps_output_at_max_hints() {
        // Build a stream of distinct fake-path tokens separated by NUL so each
        // becomes its own RefHint. 10_000 entries far exceeds the 1024 cap.
        let mut bytes: Vec<u8> = Vec::new();
        for i in 0..10_000u32 {
            let token = alloc::format!("p{i}.sldprt");
            bytes.extend_from_slice(token.as_bytes());
            bytes.push(0); // non-printable separator flushes the run
        }
        let hints = scan_bytes_for_paths(&bytes);
        assert_eq!(
            hints.len(),
            MAX_HINTS,
            "scan_bytes_for_paths must cap output at MAX_HINTS even with abundant valid input"
        );
    }

    #[test]
    fn scan_bytes_for_paths_handles_empty_input() {
        assert!(scan_bytes_for_paths(&[]).is_empty());
    }

    #[test]
    fn scan_bytes_for_paths_finds_one_path() {
        let bytes = b"\x00\x00../parts/foo.sldprt\x00";
        let hints = scan_bytes_for_paths(bytes);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].path, "../parts/foo.sldprt");
    }

    #[test]
    fn scan_bytes_for_paths_finds_utf16le_wide_path() {
        // Legacy CFB reference streams store paths as UTF-16LE (each ASCII char
        // followed by 0x00). Surround with non-aligned junk to exercise the
        // re-alignment logic.
        let mut bytes: Vec<u8> = vec![0x01, 0x02, 0x03];
        for u in "foo.sldprt".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        bytes.extend_from_slice(&[0xff, 0xff]);
        let hints = scan_bytes_for_paths(&bytes);
        assert!(
            hints.iter().any(|h| h.path == "foo.sldprt"),
            "wide (UTF-16LE) path must be decoded into a RefHint; got {hints:?}"
        );
    }
}
