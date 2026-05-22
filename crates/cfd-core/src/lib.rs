//! cfd-core: CFD tab core logic (DTOs, job registry, runner).
//!
//! Carved out of `apps/desktop/src-tauri/src/cfd/` so unit tests can
//! run without Tauri's runtime DLL footprint on Windows/GNU. The
//! desktop crate's `cfd/commands.rs` is a thin `#[tauri::command]`
//! adapter that delegates here.

pub mod capture;
pub mod dto;
pub mod load;
pub mod optimization;
pub mod params;
pub mod runner;
pub mod save;
pub mod state;

pub use state::CfdState;
