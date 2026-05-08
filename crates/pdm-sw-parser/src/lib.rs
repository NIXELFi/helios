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

// Re-exports + parse_refs added in Tasks 7-9 as their modules become populated.
