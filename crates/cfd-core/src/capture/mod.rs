//! Capture pipeline for the CFD tab.
//!
//! Three independent recorders, all hung off `engine_sim::CycleObserver`
//! (with the exception of `PipeProfileRecorder`, which is a pull-based
//! snapshot — see below).
//!
//!   - [`PvLoopRecorder`] — per-cylinder (theta_local, V, p, T, x_b)
//!     time series for one cycle. Used to render P-V loops + p(θ) /
//!     T(θ) / x_b(θ) traces. Implements `CycleObserver`.
//!
//!   - [`PipeProfileRecorder`] — end-of-cycle snapshot of every pipe's
//!     real-cell primitives (ρ, u, p, T). Used to render per-pipe
//!     profile plots. NOT a `CycleObserver`; called once via
//!     [`PipeProfileRecorder::snapshot_from`] after the cycle finishes.
//!
//!   - [`WaveFrameWriter`] — JSONL frame stream that writes every Nth
//!     step's pipe primitives + cylinder state to disk. Phase 3 ships
//!     the writer only; Phase 4 builds the viewer. Implements
//!     `CycleObserver`.
//!
//! These types live in their own crate (not engine-sim) so the parity-
//! locked sim doesn't gain serde/IO dependencies it doesn't need.

pub mod pv;
pub mod profiles;
pub mod waves;

pub use pv::{PvLoopRecorder, PvSample, PvLoopArtifact};
pub use profiles::{PipeProfile, PipeProfileRecorder, PipeProfileArtifact};
pub use waves::{WaveFrameManifest, WaveFrameWriter, WavePipeMeta};
