// Filled in by Task 9.

use crate::ref_hint::RefHint;
use cfb::CompoundFile;
use std::io::{Read, Seek};
use alloc::vec::Vec;

pub fn extract_refs<F: Read + Seek>(_comp: &mut CompoundFile<F>) -> Vec<RefHint> {
    Vec::new()
}
