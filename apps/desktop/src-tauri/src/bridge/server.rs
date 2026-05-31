//! The loopback HTTP server for the SOLIDWORKS add-in bridge.
//!
//! Binds to `127.0.0.1` on an OS-assigned port and answers a tiny JSON API the
//! Helios SOLIDWORKS add-in calls (check-in/out, get-latest, versions, lock
//! status). The add-in discovers the port + auth token from the discovery file
//! written by `super::write_discovery_file`.
//!
//! Phase 2, commit 1: this is the skeleton — a guarded `/health` endpoint plus
//! the request guard. The real endpoints land in later commits; until then they
//! return 501 so the surface is visible and curl-testable.
//!
//! ## Why this is safe to expose on localhost
//! `127.0.0.1` is not reachable off-box, but other *local* processes (and, via a
//! malicious web page, the user's browser) can still reach it. Three guards keep
//! this from becoming a way to drive someone's vault:
//!   1. **Bearer token** — every request must carry `Authorization: Bearer
//!      <token>`, where `<token>` is a per-launch random secret only readable
//!      from the discovery file (which lives under the user's profile).
//!   2. **No `Origin`** — our native add-in never sends an `Origin` header; a
//!      browser always does on cross-origin requests. We reject any request that
//!      carries one, which shuts the door on web-page-driven CSRF.
//!   3. **Loopback bind** — we only ever bind `127.0.0.1`, never `0.0.0.0`.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;

use super::BridgeState;

/// Build the router for the bridge API. Split out so it can be unit-tested
/// without binding a socket.
pub fn router(state: Arc<BridgeState>) -> Router {
    Router::new()
        .route("/health", get(health))
        // Endpoint surface — wired in later commits. Present now as 501 stubs so
        // the shape is discoverable and the add-in can be scaffolded against it.
        .route("/status", get(not_implemented))
        .route("/versions", get(not_implemented))
        .route("/checkout", post(not_implemented))
        .route("/checkin", post(not_implemented))
        .route("/get-latest", post(not_implemented))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Request guard: reject anything that isn't an authenticated, non-browser
/// caller. Runs before every route (see the security note at the top).
async fn guard(State(state): State<Arc<BridgeState>>, req: Request, next: Next) -> Response {
    // A browser always attaches Origin on cross-origin requests; our native
    // add-in never does. Refuse outright so a web page can't drive the vault.
    if req.headers().contains_key(header::ORIGIN) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }

    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));

    match presented {
        Some(tok) if tok == state.token => next.run(req).await,
        _ => (StatusCode::UNAUTHORIZED, "bad or missing bearer token").into_response(),
    }
}

/// Liveness + readiness probe. The add-in polls this to know the bridge is up
/// and whether Helios has a signed-in session / configured vault yet.
async fn health(State(state): State<Arc<BridgeState>>) -> impl IntoResponse {
    let inner = state.read();
    Json(json!({
        "ok": true,
        "service": "helios-vault-bridge",
        // Enough for the add-in to show "connect / sign in to Helios" guidance
        // without leaking anything sensitive.
        "hasSession": inner.session.is_some(),
        "vaultRoot": inner.snapshot.vault_root,
        "files": inner.snapshot.files.len(),
    }))
}

/// Placeholder for endpoints not yet wired up.
async fn not_implemented() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": "not implemented yet (Phase 2 in progress)" })),
    )
}
