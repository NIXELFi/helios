use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CoreError {
    #[error("invalid id: {0}")]
    InvalidId(alloc::string::String),
    #[error("invalid sha256 (expected 64 lowercase hex chars): {0}")]
    InvalidSha256(alloc::string::String),
    #[error("invalid role (expected admin|editor|viewer): {0}")]
    InvalidRole(alloc::string::String),
}
