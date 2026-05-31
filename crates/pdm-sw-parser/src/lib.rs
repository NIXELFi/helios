//! Parses SolidWorks `.sldasm` / `.sldprt` files (Compound File Binary
//! containers) and extracts referenced part / sub-assembly path hints.
//!
//! Best-effort. Returns an empty Vec on unparseable input rather than panicking,
//! so callers (the parse-refs edge function, future SW add-in) can apply
//! retry / log policies without bringing down request paths.

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
pub fn parse_refs(bytes: &[u8]) -> alloc::vec::Vec<RefHint> {
    cfb_reader::list_refs(bytes).unwrap_or_default()
}
