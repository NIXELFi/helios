//! Host-side plugin runtime logic, kept free of any Tauri/WebView dependency so
//! the security-critical pieces (path-traversal rejection, `plugin://` URI
//! parsing) are unit-testable in isolation and in CI without the desktop crate's
//! WebView2 link. The Tauri glue (app-data-dir lookup, the registered scheme
//! handler, the active-version registry) lives in `apps/desktop/src-tauri/src/plugins`
//! and calls into here.

pub mod bundle;
pub mod pack;
pub mod path;
pub mod uri;
pub mod verify;

/// The plugin-document Content-Security-Policy. Attached as a response header by
/// the `plugin://` protocol (production) and injected into the srcDoc `<meta>` by
/// `PluginHost.withCsp` (Sub-project A dev path). MUST stay byte-identical to
/// `PLUGIN_CSP` in `apps/desktop/src/modules/marketplace/runtime/PluginHost.tsx` —
/// the srcDoc and header paths must enforce the exact same wall. The pin test
/// below fails CI if this string drifts.
pub const PLUGIN_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; child-src blob:; form-action 'none'; base-uri 'none'";

#[cfg(test)]
mod csp_tests {
    use super::PLUGIN_CSP;

    #[test]
    fn csp_is_pinned() {
        // Update PluginHost.tsx's PLUGIN_CSP in the same change if this fails.
        assert_eq!(
            PLUGIN_CSP,
            "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src blob:; child-src blob:; form-action 'none'; base-uri 'none'"
        );
        // The two clauses that ARE the network wall — assert their presence
        // independently of ordering so a careless reorder still keeps them.
        assert!(PLUGIN_CSP.contains("default-src 'none'"));
        assert!(PLUGIN_CSP.contains("connect-src 'none'"));
    }
}
