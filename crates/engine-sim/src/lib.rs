//! engine-sim: Rust port of the 1D finite-volume engine cycle simulator.
//!
//! See `docs/superpowers/specs/2026-05-20-engine-sim-rust-port-design.md`
//! in the parent repo for design + porting tolerance policy.

pub mod bcs;
pub mod config;
pub mod cylinder;
pub mod model;
pub mod solver;
