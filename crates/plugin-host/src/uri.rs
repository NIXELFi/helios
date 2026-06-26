//! Parsing for `plugin://` asset requests, free of any webview dependency.
//!
//! Tauri presents custom-scheme requests differently per platform: on macOS/Linux
//! the plugin id lands in the URI authority (`plugin://<id>/<path>`), while on
//! Windows WebView2 rewrites custom schemes to `http://<scheme>.localhost/<id>/<path>`,
//! putting the id in the FIRST PATH SEGMENT with host `plugin.localhost`. We accept
//! both shapes (and unit-test both) so neither platform regresses; the exact shape
//! Tauri actually delivers is confirmed by a live smoke test.

/// Extract `(plugin_id, rel_path)` from a request's `(path, host)`, percent-decoding
/// both. Returns `None` if there is no asset path (e.g. `plugin://<id>/` with no
/// file) or on a malformed `%XX`/NUL.
pub fn parse_request(path: &str, host: Option<&str>) -> Option<(String, String)> {
    let host_is_id = match host {
        None => false,
        Some(h) => !h.is_empty() && h != "localhost" && h != "plugin.localhost",
    };

    if host_is_id {
        let id = host.unwrap().to_string();
        let rel = percent_decode(path.trim_start_matches('/'))?;
        if rel.is_empty() {
            return None;
        }
        Some((id, rel))
    } else {
        let trimmed = path.trim_start_matches('/');
        let (id, rest) = trimmed.split_once('/')?; // need `<id>/<something>`
        let id = percent_decode(id)?;
        let rel = percent_decode(rest)?;
        if id.is_empty() || rel.is_empty() {
            return None;
        }
        Some((id, rel))
    }
}

/// Minimal, dependency-free percent-decoder. Returns `None` on a malformed `%XX`
/// sequence or a decoded NUL (the path resolver also rejects NUL; failing here
/// keeps it a clean parse error).
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let h = *bytes.get(i + 1)?;
                let l = *bytes.get(i + 2)?;
                out.push((hex_val(h)? << 4) | hex_val(l)?);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    if out.contains(&0) {
        return None;
    }
    String::from_utf8(out).ok()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Conservative file-extension -> MIME map covering everything a sandboxed web
/// bundle can legitimately reference. Unknown types fall back to octet-stream so
/// they can't be coerced into executing (paired with `X-Content-Type-Options:
/// nosniff` at the response layer).
pub fn content_type_for(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" | "map" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parses_id_from_authority_unix_shape() {
        assert_eq!(
            parse_request("/dist/index.html", Some("aero.downforce")),
            Some(("aero.downforce".into(), "dist/index.html".into()))
        );
    }

    #[test]
    fn parses_id_from_first_segment_windows_shape() {
        assert_eq!(
            parse_request("/aero.downforce/dist/index.html", Some("plugin.localhost")),
            Some(("aero.downforce".into(), "dist/index.html".into()))
        );
    }

    #[test]
    fn parses_id_from_first_segment_when_no_host() {
        assert_eq!(
            parse_request("/aero.downforce/index.html", None),
            Some(("aero.downforce".into(), "index.html".into()))
        );
    }

    #[test]
    fn rejects_no_asset_path() {
        assert_eq!(parse_request("/", Some("aero.downforce")), None);
        assert_eq!(parse_request("/aero.downforce", Some("plugin.localhost")), None);
    }

    #[test]
    fn percent_decodes_paths() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("dist%2Findex.html").as_deref(), Some("dist/index.html"));
        // Decoded traversal is preserved here (the path resolver rejects `..`);
        // this layer only guarantees a clean string, not safety.
        assert_eq!(percent_decode("%2e%2e").as_deref(), Some(".."));
        assert_eq!(percent_decode("%2"), None);
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%00"), None);
    }

    #[test]
    fn content_type_covers_web_assets() {
        assert_eq!(content_type_for(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type_for(Path::new("a/app.js")), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for(Path::new("a/sim.wasm")), "application/wasm");
        assert_eq!(content_type_for(Path::new("a/weird.xyz")), "application/octet-stream");
    }
}
