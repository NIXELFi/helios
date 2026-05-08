use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RefHint {
    /// Raw path string as it appeared in the SW file. May be Windows-style
    /// (`..\parts\foo.sldprt`), Unix-style (`/Users/x/foo.sldprt`), or just a
    /// basename (`foo.sldprt`). Resolution against the vault is done elsewhere.
    pub path: String,
}

impl RefHint {
    /// Last path segment after either '/' or '\\'.
    pub fn basename(&self) -> &str {
        let last_slash = self.path.rfind(|c: char| c == '/' || c == '\\');
        match last_slash {
            Some(i) => &self.path[i + 1..],
            None => &self.path,
        }
    }
}
