//! Traversal-safe filesystem paths for the plugin install cache. Plugin ids,
//! versions, and in-frame request paths are all UNTRUSTED (they come from a
//! manifest and from `location` strings inside the sandbox), so every value that
//! becomes part of a filesystem path is validated here. A bug in this module is a
//! sandbox escape (arbitrary file read off the plugin origin), so it is tested
//! exhaustively.

use std::path::{Component, Path, PathBuf};

/// A string usable as a single directory name: non-empty, not `.`/`..`, no path
/// separators or NULs, length-bounded, and restricted to a conservative charset.
/// Plugin ids are dotted (`aero.downforce-calculator`) and versions are semver
/// (`1.2.0`), so `.`, `-`, `_` are allowed — only separators and parent refs are
/// forbidden.
pub fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= 200
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Join an untrusted relative request path onto a plugin version's base directory,
/// guaranteeing the result never escapes `base`. Absolute paths, Windows prefixes
/// (`C:\`), parent refs (`..`), and current-dir refs are all rejected — only plain
/// name components are joined. Returns `None` on any violation or an empty path.
/// The caller must have already percent-decoded `rel`.
pub fn resolve(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || rel.contains('\0') {
        return None;
    }
    let mut out = base.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            // The ONLY accepted component kind. RootDir, Prefix (drive letter),
            // ParentDir (`..`) and CurDir (`.`) can all escape `base`, so we
            // refuse the whole request rather than try to sanitize it.
            Component::Normal(seg) => out.push(seg),
            _ => return None,
        }
    }
    // Defense in depth: with only Normal components this always holds, but assert
    // it rather than assume it.
    if out.starts_with(base) {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_segment_accepts_plugin_ids_and_versions() {
        assert!(is_safe_segment("aero.downforce-calculator"));
        assert!(is_safe_segment("1.2.0"));
        assert!(is_safe_segment("suspension_spring-rate"));
        assert!(is_safe_segment("a"));
    }

    #[test]
    fn safe_segment_rejects_traversal_and_separators() {
        assert!(!is_safe_segment(""));
        assert!(!is_safe_segment("."));
        assert!(!is_safe_segment(".."));
        assert!(!is_safe_segment("a/b"));
        assert!(!is_safe_segment("a\\b"));
        assert!(!is_safe_segment("a\0b"));
        assert!(!is_safe_segment("a b")); // space not in charset
        assert!(!is_safe_segment("a:b")); // drive-letter-ish
        assert!(!is_safe_segment(&"x".repeat(201))); // absurdly long
    }

    #[test]
    fn resolve_allows_normal_nested_paths() {
        let base = Path::new("/srv/plugins/aero/1.0.0");
        let got = resolve(base, "dist/index.html").unwrap();
        assert_eq!(got, base.join("dist").join("index.html"));
    }

    #[test]
    fn resolve_strips_leading_slash() {
        let base = Path::new("/srv/plugins/aero/1.0.0");
        let got = resolve(base, "/index.html").unwrap();
        assert_eq!(got, base.join("index.html"));
    }

    #[test]
    fn resolve_rejects_parent_traversal() {
        let base = Path::new("/srv/plugins/aero/1.0.0");
        assert!(resolve(base, "../1.0.0/index.html").is_none());
        assert!(resolve(base, "../../secrets.txt").is_none());
        assert!(resolve(base, "dist/../../../etc/passwd").is_none());
    }

    #[test]
    fn resolve_rejects_absolute_and_empty() {
        let base = Path::new("/srv/plugins/aero/1.0.0");
        assert!(resolve(base, "").is_none());
        assert!(resolve(base, "/").is_none());
        #[cfg(windows)]
        {
            assert!(resolve(base, "C:\\Windows\\system32").is_none());
            assert!(resolve(base, "\\\\server\\share").is_none());
        }
    }

    #[test]
    fn resolve_rejects_nul() {
        let base = Path::new("/srv/plugins/aero/1.0.0");
        assert!(resolve(base, "dist/\0evil").is_none());
    }
}
