use crate::error::CoreError;
use alloc::format;
use alloc::string::{String, ToString};
use core::fmt;
use core::str::FromStr;
use serde::{Deserialize, Serialize};

/// Lowercase-hex sha-256 digest, 64 chars.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sha256(String);

impl Sha256 {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Path under `vault-objects` Storage bucket: `<first2hex>/<full>`.
    pub fn storage_path(&self) -> String {
        format!("{}/{}", &self.0[..2], &self.0)
    }
}

impl fmt::Display for Sha256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Sha256 {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.len() != 64 {
            return Err(CoreError::InvalidSha256(s.to_string()));
        }
        // Accept both upper- and lower-case hex from the wire, but store
        // canonically lowercased so equality / hashing stay consistent.
        let lower = s.to_ascii_lowercase();
        for c in lower.chars() {
            let valid = c.is_ascii_digit() || ('a'..='f').contains(&c);
            if !valid {
                return Err(CoreError::InvalidSha256(s.to_string()));
            }
        }
        Ok(Self(lower))
    }
}

impl TryFrom<String> for Sha256 {
    type Error = CoreError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<Sha256> for String {
    fn from(s: Sha256) -> Self {
        s.0
    }
}
