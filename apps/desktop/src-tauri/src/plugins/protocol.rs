// The `plugin://` asset protocol. Installed plugins are served from the local
// cache (see `cache.rs`) at this isolated scheme so the entry document carries the
// strict plugin CSP as a *response header*. (The Sub-project A dev path injects the
// same CSP into a srcDoc meta tag; switching an installed plugin to
// `src="plugin://…"` bypasses that injection, so the header here is the network
// wall for installed/untrusted plugins.)
//
// Cross-plugin isolation is still provided by A's `sandbox="allow-scripts"`
// opaque-origin iframe — `plugin://` exists to serve cached files and to give the
// navigation handler a scheme to allowlist, NOT to grant each plugin a real
// per-origin boundary.
//
// The pure parsing/MIME/CSP logic lives in the `plugin-host` crate; this file is
// just the Tauri glue (the registered handler + the active-version registry).

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, UriSchemeContext, Wry};

use super::cache;
use plugin_host::{uri, PLUGIN_CSP};

/// Maps an installed plugin id -> the version currently served at `plugin://<id>/`.
/// Written by the install/uninstall commands (Sub-project B Phase 4); read here on
/// every asset request. Empty until a plugin is installed, so the dev srcDoc path
/// (A) is unaffected.
#[derive(Default)]
pub struct ActiveVersions(pub Mutex<HashMap<String, String>>);

impl ActiveVersions {
    pub fn get(&self, plugin_id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(plugin_id)
            .cloned()
    }

    pub fn set(&self, plugin_id: String, version: String) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(plugin_id, version);
    }

    pub fn remove(&self, plugin_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(plugin_id);
    }
}

/// Sync handler registered for the `plugin` scheme. Never panics into the webview:
/// any failure becomes a 4xx/5xx with an empty body (still CSP-headered).
pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let app = ctx.app_handle();
    match serve(app, request) {
        Ok((body, content_type)) => Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Content-Security-Policy", PLUGIN_CSP)
            // Belt-and-suspenders: never let the webview MIME-sniff plugin bytes
            // into something executable we didn't label.
            .header("X-Content-Type-Options", "nosniff")
            // The loader fetches the manifest + entry from the APP webview, which is a
            // different origin than this scheme (tauri.localhost / localhost:1420 ->
            // plugin.localhost), so the cross-origin read needs ACAO. These are the
            // plugin's own local bundle files (no secrets); the real isolation is the
            // sandboxed srcdoc iframe, so `*` is safe here.
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .expect("static response builder never fails"),
        Err(status) => Response::builder()
            .status(status)
            .header("Content-Security-Policy", PLUGIN_CSP)
            // Same cross-origin read path as the 200 case — without ACAO the loader
            // sees even a clean 404/403 as an opaque "Failed to fetch".
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .expect("static response builder never fails"),
    }
}

fn serve(app: &AppHandle, request: Request<Vec<u8>>) -> Result<(Vec<u8>, &'static str), u16> {
    let (plugin_id, rel_path) =
        uri::parse_request(request.uri().path(), request.uri().host()).ok_or(400u16)?;

    // Which version is live for this plugin? Unknown id => 404 (nothing installed).
    let version = app.state::<ActiveVersions>().get(&plugin_id).ok_or(404u16)?;

    let base = cache::version_dir(app, &plugin_id, &version).map_err(|_| 400u16)?;
    let resolved = cache::resolve(&base, &rel_path).ok_or(403u16)?;

    let bytes = std::fs::read(&resolved).map_err(|_| 404u16)?;
    Ok((bytes, uri::content_type_for(&resolved)))
}
