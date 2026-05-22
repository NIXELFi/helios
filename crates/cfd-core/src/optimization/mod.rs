//! Optimization primitives: samplers, bounds mapping, objective evaluation.
//!
//! Pure functions, no I/O, no Tauri. The runner glues these together
//! over `SDM26Engine`.

pub mod bounds;
pub mod sampler;
