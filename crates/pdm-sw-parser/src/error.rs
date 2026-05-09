use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("input is not a valid Compound File Binary container: {0}")]
    NotCfb(String),
    #[error("CFB stream `{0}` is missing")]
    MissingStream(String),
    #[error("CFB stream `{0}` cannot be read: {1}")]
    UnreadableStream(String, String),
}
