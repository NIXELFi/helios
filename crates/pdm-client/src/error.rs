use pdm_core::LockId;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("config: {0}")]
    Config(String),
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("invalid URL: {0}")]
    Url(#[from] url::ParseError),
    #[error("authentication required")]
    Unauthenticated,
    #[error("forbidden (RLS rejected): {0}")]
    Forbidden(String),
    #[error("server returned {status}: {body}")]
    Server { status: u16, body: String },
    #[error("decode response: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("lock {0} was already released by another client")]
    LockAlreadyReleased(LockId),
}
