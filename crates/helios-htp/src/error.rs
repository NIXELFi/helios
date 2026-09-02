use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum HtpError {
    #[error("bad magic {0:#06x}")]
    BadMagic(u16),
    #[error("unsupported version {0}")]
    BadVersion(u8),
    #[error("flags must be 0, got {0}")]
    BadFlags(u8),
    #[error("window_count {0} outside 1..=8")]
    BadWindowCount(u8),
    #[error("unknown group_key {0}")]
    UnknownGroup(u8),
    #[error("body length {actual} != expected {expected}")]
    BadLength { expected: usize, actual: usize },
    #[error("window {window}: channel {channel} has {got} samples, group rate is {want}")]
    BadSampleCount { window: usize, channel: String, got: usize, want: usize },
    #[error("value count {got} != channel count {want}")]
    BadValueCount { got: usize, want: usize },
    #[error("base64: {0}")]
    Base64(String),
}
