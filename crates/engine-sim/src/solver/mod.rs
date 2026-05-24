//! Quasi-1D compressible-Euler solver: pipe state, HLLC, MUSCL-Hancock,
//! source terms. Mirrors the layout of `solver/` in the Python tree.

pub mod state;
pub mod hllc;
pub mod muscl;
pub mod weno;
pub mod sources;
