use crate::ref_hint::RefHint;
use cfb::CompoundFile;
use std::io::{Read, Seek};
use alloc::string::String;
use alloc::vec::Vec;

const SW_EXTENSIONS: &[&str] = &[".sldprt", ".sldasm", ".slddrw"];

/// Walk the container, find streams whose name contains "Reference", and scan
/// each one for printable-ASCII runs that end in a SolidWorks extension. Each
/// match becomes a RefHint.
///
/// Best-effort across SW versions — formats differ. We err on the side of
/// recall over precision; consumers dedupe by basename.
pub fn extract_refs<F: Read + Seek>(comp: &mut CompoundFile<F>) -> Vec<RefHint> {
    let candidate_streams: Vec<String> = comp
        .walk()
        .filter(|e| e.is_stream())
        .map(|e| e.path().to_string_lossy().into_owned())
        .filter(|name| name.contains("Reference"))
        .collect();

    let mut hints = Vec::new();
    for stream_name in candidate_streams {
        let mut buf = Vec::new();
        if let Ok(mut s) = comp.open_stream(&stream_name) {
            if s.read_to_end(&mut buf).is_ok() {
                hints.extend(scan_bytes_for_paths(&buf));
            }
        }
    }
    hints
}

fn scan_bytes_for_paths(bytes: &[u8]) -> Vec<RefHint> {
    // Strategy: collect maximal runs of printable-ASCII bytes (and the path
    // separators / : drive letter), then keep each run that ends in one of
    // the SW extensions.
    let mut out = Vec::new();
    let mut current = String::new();
    for &b in bytes {
        if is_printable(b) {
            current.push(b as char);
        } else {
            check_and_push(&mut current, &mut out);
            current.clear();
        }
    }
    check_and_push(&mut current, &mut out);
    out
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
