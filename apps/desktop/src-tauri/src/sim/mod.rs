//! The driver-in-loop simulator, as seen from Helios.
//!
//! Helios is the team's launcher and archive for `fsae-sim`: it starts the
//! simulator with a driver's name and a course, and it owns everything that
//! comes back. The two programs share a directory rather than a protocol --
//! the simulator only ever writes a run directory, Helios only ever reads one,
//! and neither needs the other to be running.
//!
//!   %LOCALAPPDATA%\Helios\sim-runs\<runId>\run.json        the manifest
//!   %LOCALAPPDATA%\Helios\sim-runs\<runId>\telemetry.csv   100 Hz channels
//!
//! `HELIOS_SIM_RUNS_DIR` overrides the location, which is what a team running
//! off a shared drive would set on every rig. `FSAE_SIM_RUNS_DIR` is honoured
//! too, because that is the name the simulator itself reads, and a machine
//! that has set one has almost certainly meant both.
//!
//! The telemetry file is a plain Helios-canonical CSV, so "open this run in
//! Logs" is the existing `load_csv` path with no special case anywhere: a
//! simulator run and a test-day log overlay on the same axes.
//!
//! Helios does NOT bundle the simulator. It finds one that is installed, and
//! `install.rs` can fetch one on request -- so a user who only wants PM and
//! the Vault never downloads a driving simulator, and a user who wants one
//! gets it without a toolchain.

// Both are public because `tauri::generate_handler!` needs the hidden
// `__cmd__<name>` macro that `#[tauri::command]` generates beside each
// function, and a `pub use` of the function alone does not re-export it. So
// `lib.rs` names `sim::runs::sim_list_runs` and friends in full.
pub mod install;
pub mod launch;
pub mod runs;
