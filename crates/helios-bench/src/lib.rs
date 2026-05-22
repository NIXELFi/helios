//! Helios bench: the reproducibility unit for physics agent investigations.
//!
//! CLI is canonical (per spec C11). This lib surface lets `helios-mcp`
//! call the same code paths without shelling out.

pub mod cmd;
pub mod environment;
pub mod ndjson;
pub mod study;
