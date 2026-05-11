//! Shared domain types for the Helios Vault PDM module.
//!
//! No I/O, no async — but this crate depends on chrono (default features),
//! uuid (v4), and serde_json, all of which require `std`. An earlier comment
//! claimed `no_std + alloc` cleanliness for the parse-refs edge function;
//! the 2026-05-11 audit found that claim to be aspirational rather than
//! actual. The misleading `#![cfg_attr(not(feature = "std"), no_std)]`
//! attribute has been removed in favour of accurate docs.
//!
//! Submodules still reference `alloc::` paths from the prior no_std stance;
//! `extern crate alloc` is kept so those paths continue to resolve under
//! std without touching every file.

extern crate alloc;

pub mod audit;
pub mod error;
pub mod ids;
pub mod role;
pub mod sha256;
pub mod vault;

pub use audit::{AuditAction, AuditEntry};
pub use error::CoreError;
pub use ids::{FileId, FolderId, LockId, UserId, VaultId, VersionId};
pub use role::Role;
pub use sha256::Sha256;
pub use vault::{File, Folder, Lock, Ref, Vault, Version};
