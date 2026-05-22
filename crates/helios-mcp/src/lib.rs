//! Helios MCP server library.
//!
//! Per spec C11 and Known Issue I-5: this is an in-house stdio JSON-RPC
//! 2.0 server that wraps the `helios-bench` library. We do NOT depend on
//! any external MCP SDK — the protocol is small (newline-delimited
//! JSON-RPC) and a moving SDK ecosystem is a supply-chain risk.
//!
//! The MCP server cannot expose any capability the CLI doesn't (spec
//! C11). Every tool is a thin wrapper over a `helios_bench::cmd::*::
//! execute_with` call or a filesystem read of `physics_findings/`.

pub mod handlers;
pub mod library_api;
pub mod protocol;
pub mod server;

pub use protocol::{ErrorObject, Notification, Request, Response};
pub use server::Server;
