//! Shared domain types for the Helios Vault PDM module.
//!
//! No I/O, no async, no std-only APIs — this crate is `no_std + alloc` clean
//! so it can be compiled to WASM for the parse-refs edge function.

#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;

pub mod audit;
pub mod error;
pub mod ids;
pub mod role;
pub mod sha256;
pub mod vault;
