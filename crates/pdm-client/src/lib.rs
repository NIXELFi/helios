//! Typed HTTP client for the Helios Vault Supabase backend.
//!
//! Wraps the PostgREST + Storage + RPC surfaces defined by the migrations in
//! `infra/pdm-supabase/`. All operations return strongly-typed results from
//! `pdm-core`. Auth is JWT-based; the client refreshes its session token
//! automatically on 401.

pub mod auth;
pub mod cancel;
pub mod check_in;
pub mod client;
pub mod error;
pub mod files;
pub mod folders;
pub mod force_unlock;
pub mod locks;
pub mod storage;
pub mod vaults;
pub mod versions;

pub use client::{Client, ClientBuilder};
pub use error::ClientError;
