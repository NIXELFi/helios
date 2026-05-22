//! Build script: captures target triple, rustc version, and a libm-source
//! heuristic so the runtime `environment::capture()` can stamp NDJSON
//! result files (spec C4).

use std::process::Command;

fn main() {
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=HELIOS_BENCH_TARGET_TRIPLE={triple}");

    let rustc_out = Command::new("rustc")
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=HELIOS_BENCH_RUSTC_VERSION={rustc_out}");

    let libm = if triple.contains("windows-msvc") {
        "system"
    } else if triple.contains("linux-gnu") {
        "system-glibc"
    } else if triple.contains("musl") {
        "musl"
    } else {
        "unknown"
    };
    println!("cargo:rustc-env=HELIOS_BENCH_LIBM_SOURCE={libm}");

    println!("cargo:rerun-if-changed=build.rs");
}
