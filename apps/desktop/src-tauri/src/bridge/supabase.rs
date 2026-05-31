//! Minimal Supabase (PostgREST) client for the bridge's native metadata ops.
//!
//! These mirror the frontend hooks exactly so behavior is identical whether an
//! action comes from the Helios UI or the SOLIDWORKS add-in:
//!   - `versions` ← `useVersions`  (`GET versions?file_id=eq.&order=version_num.desc`)
//!   - `acquire_lock` ← `useAcquireLock`  (`INSERT locks {file_id, user_id}`)
//!
//! The Vault uses the `pdm` Postgres schema, so reads send `Accept-Profile: pdm`
//! and writes send `Content-Profile: pdm` (PostgREST schema selection). Calls are
//! made as the signed-in user: the anon key as `apikey`, the user's JWT as the
//! bearer — so row-level security applies exactly as it does in the app.

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

use super::Session;

/// Error from a Supabase call: an HTTP-ish status to relay to the add-in plus a
/// message. Kept simple — the add-in surfaces the message to the user.
pub struct SupaError {
    pub status: u16,
    pub message: String,
}

impl SupaError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

type SupaResult = Result<Value, SupaError>;

/// Common headers for an authenticated PostgREST request as the signed-in user.
fn base_headers(s: &Session) -> Result<HeaderMap, SupaError> {
    let mut h = HeaderMap::new();
    let bearer = format!("Bearer {}", s.access_token);
    let mut insert = |k: reqwest::header::HeaderName, v: &str| -> Result<(), SupaError> {
        let hv = HeaderValue::from_str(v)
            .map_err(|e| SupaError::new(500, format!("bad header value: {e}")))?;
        h.insert(k, hv);
        Ok(())
    };
    insert(reqwest::header::HeaderName::from_static("apikey"), &s.anon_key)?;
    insert(AUTHORIZATION, &bearer)?;
    insert(CONTENT_TYPE, "application/json")?;
    Ok(h)
}

/// `GET /rest/v1/versions?file_id=eq.<id>&order=version_num.desc` — full version
/// history for a file, newest first. Mirrors `useVersions`.
pub async fn get_versions(
    http: &reqwest::Client,
    s: &Session,
    file_id: &str,
) -> SupaResult {
    let url = format!("{}/rest/v1/versions", s.supabase_url.trim_end_matches('/'));
    let mut headers = base_headers(s)?;
    // Read path: select from the `pdm` schema.
    headers.insert(
        reqwest::header::HeaderName::from_static("accept-profile"),
        HeaderValue::from_static("pdm"),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

    let resp = http
        .get(&url)
        .headers(headers)
        .query(&[
            ("file_id", format!("eq.{file_id}")),
            ("order", "version_num.desc".to_string()),
            ("select", "*".to_string()),
        ])
        .send()
        .await
        .map_err(|e| SupaError::new(502, format!("versions request failed: {e}")))?;

    parse_json(resp).await
}

/// `INSERT locks {file_id, user_id}` returning the created row — check-out.
/// Mirrors `useAcquireLock`. A 409 (unique violation) means the file is already
/// checked out; the add-in surfaces that to the user.
pub async fn acquire_lock(
    http: &reqwest::Client,
    s: &Session,
    file_id: &str,
) -> SupaResult {
    let url = format!("{}/rest/v1/locks", s.supabase_url.trim_end_matches('/'));
    let mut headers = base_headers(s)?;
    // Write path: target the `pdm` schema, and ask for the inserted row back.
    headers.insert(
        reqwest::header::HeaderName::from_static("content-profile"),
        HeaderValue::from_static("pdm"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("prefer"),
        HeaderValue::from_static("return=representation"),
    );

    let body = json!({ "file_id": file_id, "user_id": s.user_id });
    let resp = http
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| SupaError::new(502, format!("checkout request failed: {e}")))?;

    // PostgREST returns the inserted rows as an array; unwrap to the single row.
    match parse_json(resp).await {
        Ok(Value::Array(mut rows)) if !rows.is_empty() => Ok(rows.remove(0)),
        Ok(other) => Ok(other),
        Err(e) => Err(e),
    }
}

/// Turn a PostgREST response into JSON, mapping non-2xx into a `SupaError` that
/// carries the upstream status + body so the add-in can show a real message.
async fn parse_json(resp: reqwest::Response) -> SupaResult {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| SupaError::new(502, format!("bad JSON from Supabase: {e}")))
    } else {
        // Surface PostgREST's own message when present, else the raw body.
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("error"))
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .unwrap_or(text);
        Err(SupaError::new(status.as_u16(), msg))
    }
}
