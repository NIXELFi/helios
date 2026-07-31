//! Parses SolidWorks `.sldasm` / `.sldprt` files (Compound File Binary
//! containers) and extracts referenced part / sub-assembly path hints.
//!
//! Best-effort in the sense that it never panics on hostile input — but it does
//! NOT collapse "unparseable" into "no references". Callers (the parse-refs edge
//! function, the SW add-in) get a [`ParseError`] so they can apply retry / log
//! policies; treating a parse failure as an empty ref list would let a caller
//! wipe a real parent→child graph (where-used, get-latest-with-refs) on the
//! strength of a file it couldn't even open.

extern crate alloc;

pub mod cfb_reader;
pub mod error;
pub mod ref_hint;
pub mod sldasm;
pub mod sw_properties;

pub use error::ParseError;
pub use ref_hint::RefHint;
pub use sw_properties::{parse_properties, SwProperty};

/// Top-level entry point.
///
/// `Ok(vec![])` means "this IS a SolidWorks container and it genuinely has no
/// references". `Err(ParseError::NotCfb)` means "we could not read this at all"
/// — a truncated download, a non-SW file, an in-place-edited doc. The two must
/// stay distinguishable: the ref recorder replaces a version's whole ref set
/// with whatever it's handed, so returning an empty Vec for the second case
/// silently deletes a working where-used graph.
pub fn parse_refs(bytes: &[u8]) -> Result<alloc::vec::Vec<RefHint>, ParseError> {
    cfb_reader::list_refs(bytes).ok_or_else(|| {
        ParseError::NotCfb(alloc::string::String::from(
            "could not open the file as a Compound File Binary container",
        ))
    })
}
