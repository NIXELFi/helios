//! Environment capture for reproducibility (spec C4).
//!
//! `target_triple`, `rustc_version`, and `libm_source` are stamped at
//! build time by [`build.rs`]. `rayon_threads` is supplied by the caller
//! (from `study.toml`'s `[environment]` block or a CLI override).

use crate::study::Environment;

/// Build-time target triple (set by build.rs).
pub fn target_triple() -> &'static str {
    env!("HELIOS_BENCH_TARGET_TRIPLE")
}

/// rustc version string (set by build.rs).
pub fn rustc_version() -> &'static str {
    env!("HELIOS_BENCH_RUSTC_VERSION")
}

/// Best-effort heuristic from build.rs: "system" on windows-msvc,
/// "system-glibc" on linux-gnu, "musl" on musl, otherwise "unknown".
pub fn libm_source() -> &'static str {
    env!("HELIOS_BENCH_LIBM_SOURCE")
}

/// Capture the current environment as a study `Environment` block.
pub fn capture(rayon_threads: u32) -> Environment {
    Environment {
        target_triple: target_triple().into(),
        rustc_version: rustc_version().into(),
        rayon_threads,
        libm_source: libm_source().into(),
    }
}

/// Compare two environments. Returns Ok with a warnings list on compatible
/// (any non-target-triple diff is a warning). Err on hard target_triple
/// mismatch — that's an incompatible host.
pub fn check_compatible(
    actual: &Environment,
    recorded: &Environment,
) -> Result<Vec<String>, String> {
    if actual.target_triple != recorded.target_triple {
        return Err(format!(
            "target_triple mismatch: actual {} vs recorded {}",
            actual.target_triple, recorded.target_triple
        ));
    }
    let mut warnings = Vec::new();
    if actual.rustc_version != recorded.rustc_version {
        warnings.push(format!(
            "rustc_version differs: actual {} vs recorded {}",
            actual.rustc_version, recorded.rustc_version
        ));
    }
    if actual.libm_source != recorded.libm_source {
        warnings.push(format!(
            "libm_source differs: actual {} vs recorded {}",
            actual.libm_source, recorded.libm_source
        ));
    }
    Ok(warnings)
}
