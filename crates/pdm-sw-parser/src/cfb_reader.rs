use crate::ref_hint::RefHint;
use crate::sldasm;
use cfb::CompoundFile;
use std::io::{Read, Seek};
use alloc::string::String;
use alloc::vec::Vec;

/// Open a CFB container from anything readable + seekable.
pub fn open_cfb<F: Read + Seek>(reader: F) -> Result<CompoundFile<F>, std::io::Error> {
    cfb::CompoundFile::open(reader)
}

/// List every stream name in the container (paths joined by `/`).
pub fn list_streams<F: Read + Seek>(comp: &CompoundFile<F>) -> Vec<String> {
    comp.walk()
        .filter(|entry| entry.is_stream())
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect()
}

/// Top-level: parse references from raw bytes.
/// Returns:
/// - `Some(Vec)` (possibly empty) when the input is a valid CFB.
/// - `None` when the input is not a CFB at all.
///
/// Best-effort across SW versions.
pub fn list_refs(bytes: &[u8]) -> Option<Vec<RefHint>> {
    let cursor = std::io::Cursor::new(bytes);
    let mut comp = cfb::CompoundFile::open(cursor).ok()?;
    Some(sldasm::extract_refs(&mut comp))
}
