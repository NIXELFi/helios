//! Telemetry staging compactor (handoff §5.1).
//!
//! Drains `telemetry.staging_chunks` (one Arrow IPC record batch per 1 s
//! window) into zstd parquet objects in the `telemetry-sessions` bucket and
//! 1 Hz downsampled chunks in `telemetry.downsampled_1hz`. Crash-safe by
//! construction: object keys are deterministic from the seq range, uploads
//! use upsert, and rows are marked compacted only after a verified upload —
//! a crash anywhere re-runs to convergence with no duplicates.

pub mod api;
pub mod compact;
pub mod verify;
