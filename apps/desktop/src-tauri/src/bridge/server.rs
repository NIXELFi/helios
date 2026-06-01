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
    extract::{Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use super::{supabase, BridgeState};

/// Build the router for the bridge API. Split out so it can be unit-tested
/// without binding a socket.
pub fn router(state: Arc<BridgeState>) -> Router {
    Router::new()
        .route("/health", get(health))
        // Metadata ops — served natively from the snapshot + Supabase REST, so
        // they answer even while Helios is minimized in the tray.
        .route("/status", get(status))
        .route("/versions", get(versions))
        .route("/checkout", post(checkout))
        // Blob ops — forwarded to the running UI, which has the tested
        // gzip/sha256/atomic-write code (see the `bridge://op` handler).
        .route("/checkin", post(checkin))
        .route("/get-latest", post(get_latest))
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

/// A `?path=<local file path>` query, shared by the path-addressed endpoints.
#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

/// `POST` bodies that address a file by its local path.
#[derive(Deserialize)]
struct PathBody {
    path: String,
}

/// `GET /status?path=` — what does Helios know about this local file? The
/// tracked/lock/vault facts come straight from the pushed snapshot (instant, no
/// network). The latest version/sha is looked up on demand from `latest_version_id`
/// (kept out of the snapshot to stay lean at tens of thousands of files); if
/// there's no session or the lookup fails it's simply omitted. `tracked:false`
/// means the path isn't a known vault file.
async fn status(State(state): State<Arc<BridgeState>>, Query(q): Query<PathQuery>) -> Response {
    let Some(f) = state.file_by_path(&q.path) else {
        return Json(json!({ "tracked": false, "path": q.path })).into_response();
    };

    // Resolve the latest version lazily (best-effort). Map the raw PostgREST
    // columns to the camelCase shape the add-in expects.
    let latest = match (&f.latest_version_id, state.session()) {
        (Some(vid), Some(session)) => {
            match supabase::get_version_by_id(&state.http, &session, vid).await {
                Ok(v) if v.is_object() => Some(json!({
                    "versionNum": v.get("version_num"),
                    "sha256": v.get("sha256"),
                    "revision": v.get("revision"),
                })),
                _ => None,
            }
        }
        _ => None,
    };

    let checked_out = f.lock.is_some();
    let checked_out_by_me = f.lock.as_ref().map(|l| l.by_me).unwrap_or(false);
    Json(json!({
        "tracked": true,
        "path": q.path,
        "fileId": f.file_id,
        "name": f.name,
        "vault": f.vault_name,
        "latest": latest,
        "checkedOut": checked_out,
        "checkedOutByMe": checked_out_by_me,
        "lock": f.lock,
    }))
    .into_response()
}

/// `GET /versions?path=` — full version history for the file at this path.
async fn versions(State(state): State<Arc<BridgeState>>, Query(q): Query<PathQuery>) -> Response {
    let Some(file) = state.file_by_path(&q.path) else {
        return not_tracked(&q.path);
    };
    let Some(session) = state.session() else {
        return no_session();
    };
    match supabase::get_versions(&state.http, &session, &file.file_id).await {
        Ok(rows) => Json(json!({ "fileId": file.file_id, "versions": rows })).into_response(),
        Err(e) => supa_error(e),
    }
}

/// `POST /checkout {path}` — acquire the lock for this file (check it out).
async fn checkout(State(state): State<Arc<BridgeState>>, Json(body): Json<PathBody>) -> Response {
    let Some(file) = state.file_by_path(&body.path) else {
        return not_tracked(&body.path);
    };
    let Some(session) = state.session() else {
        return no_session();
    };
    match supabase::acquire_lock(&state.http, &session, &file.file_id).await {
        Ok(lock) => {
            // Reflect the new lock immediately so the add-in's follow-up /status
            // shows "checked out by you" without waiting for the frontend's poll.
            state.mark_locked_by_me(&file.file_id);
            Json(json!({ "ok": true, "fileId": file.file_id, "lock": lock })).into_response()
        }
        Err(e) => supa_error(e),
    }
}

/// `POST /checkin {path, comment?}` — check the file in. Blob work (read, gzip,
/// sha256, upload, RPC) runs in the UI via the existing useCheckIn code; we just
/// forward and wait.
async fn checkin(State(state): State<Arc<BridgeState>>, Json(body): Json<CheckinBody>) -> Response {
    let Some(file) = state.file_by_path(&body.path) else {
        return not_tracked(&body.path);
    };
    if state.session().is_none() {
        return no_session();
    }
    let payload = json!({
        "op": "checkin",
        "fileId": file.file_id,
        "path": body.path,
        "comment": body.comment,
    });
    match forward(&state, payload).await {
        Ok(v) if op_ok(&v) => {
            state.clear_lock(&file.file_id); // check-in releases the lock
            Json(json!({ "ok": true, "fileId": file.file_id, "result": v })).into_response()
        }
        Ok(v) => op_failed(&v, "check-in failed"),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))).into_response(),
    }
}

/// `POST /get-latest {path}` — overwrite the local file with the latest version.
/// Resolves the latest sha, then forwards the download to the UI's
/// useDownloadVersion (gunzip + verify + atomic write).
async fn get_latest(State(state): State<Arc<BridgeState>>, Json(body): Json<PathBody>) -> Response {
    let Some(file) = state.file_by_path(&body.path) else {
        return not_tracked(&body.path);
    };
    let Some(session) = state.session() else {
        return no_session();
    };
    let Some(vid) = file.latest_version_id.clone() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "file has no version yet" }))).into_response();
    };
    let sha = match supabase::get_version_by_id(&state.http, &session, &vid).await {
        Ok(v) => v.get("sha256").and_then(|s| s.as_str()).map(str::to_string),
        Err(e) => return supa_error(e),
    };
    let Some(sha) = sha else {
        return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "could not resolve latest version" }))).into_response();
    };
    let payload = json!({ "op": "getLatest", "sha": sha, "destPath": body.path });
    match forward(&state, payload).await {
        Ok(v) if op_ok(&v) => Json(json!({ "ok": true, "result": v })).into_response(),
        Ok(v) => op_failed(&v, "get-latest failed"),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))).into_response(),
    }
}

/// `POST` body for check-in (path + optional comment).
#[derive(Deserialize)]
struct CheckinBody {
    path: String,
    #[serde(default)]
    comment: Option<String>,
}

/// Forward a blob op to the UI and await its reply (the UI runs the actual
/// upload/download). Times out so a hung/closed UI doesn't wedge the request.
async fn forward(
    state: &Arc<BridgeState>,
    mut payload: serde_json::Value,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let (id, rx) = state.register_pending();
    payload["id"] = json!(id);
    if let Err(e) = state.emit("bridge://op", &payload) {
        state.drop_pending(&id);
        return Err((StatusCode::SERVICE_UNAVAILABLE, e));
    }
    match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err((StatusCode::BAD_GATEWAY, "Helios UI dropped the request".into())),
        Err(_) => {
            state.drop_pending(&id);
            Err((StatusCode::GATEWAY_TIMEOUT, "timed out waiting for Helios".into()))
        }
    }
}

fn op_ok(v: &serde_json::Value) -> bool {
    v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false)
}

fn op_failed(v: &serde_json::Value, fallback: &str) -> Response {
    let msg = v.get("error").and_then(|e| e.as_str()).unwrap_or(fallback).to_string();
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
}

// --- shared error responses ------------------------------------------------

fn not_tracked(path: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "not a tracked vault file", "path": path, "tracked": false })),
    )
        .into_response()
}

fn no_session() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "Helios has no signed-in session; open Helios and sign in" })),
    )
        .into_response()
}

/// Relay a Supabase failure to the add-in, preserving the upstream status when
/// it's a sane HTTP code (else 502).
fn supa_error(e: supabase::SupaError) -> Response {
    let code = StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY);
    (code, Json(json!({ "error": e.message }))).into_response()
}
