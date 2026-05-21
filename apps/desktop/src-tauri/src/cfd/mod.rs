//! CFD tab Tauri command surface.
//!
//! Pure CFD logic (DTOs, state, runner) lives in `cfd-core`. This
//! module is a thin Tauri adapter: it re-exports CfdState so the
//! main builder can `.manage()` it, and defines the
//! `#[tauri::command]` functions in `commands`.

pub mod commands;

pub use cfd_core::CfdState;
