// Marketplace plugin runtime support on the Tauri side (Sub-project B).
//
// - `cache`    — the on-disk install cache + traversal-safe path resolution.
// - `protocol` — the `plugin://` asset scheme that serves cached bundles with the
//                strict plugin CSP as a response header.
//
// Phase 4 (verified local install) will add a `install_plugin_bundle` command that
// downloads, sha256-/signature-verifies, unzips into `cache`, and registers the
// version in `protocol::ActiveVersions`.

pub mod cache;
pub mod commands;
pub mod protocol;

pub use protocol::ActiveVersions;
