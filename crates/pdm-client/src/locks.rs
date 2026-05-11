use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{FileId, Lock, LockId, UserId};
use serde_json::{json, Value};
use url::Url;

pub fn acquire_lock_url(c: &Client) -> Url {
    c.rest_url("locks")
}

pub fn build_acquire_lock_body(file_id: FileId, user_id: UserId) -> Value {
    json!({ "file_id": file_id, "user_id": user_id })
}

pub fn release_lock_url(c: &Client, lock_id: LockId) -> Url {
    let mut u = c.rest_url("locks");
    // Only release if currently held: filter on released_at IS NULL so racing
    // clients can detect that the lock was already released (empty response).
    u.set_query(Some(&format!("id=eq.{}&released_at=is.null", lock_id)));
    u
}

pub fn build_release_lock_body() -> Value {
    json!({ "released_at": chrono::Utc::now() })
}

/// Prefer header value used on the release_lock PATCH so the response body
/// returns the affected rows. An empty array signals the lock was already
/// released by another client.
pub const RELEASE_LOCK_PREFER_HEADER: &str = "return=representation";

pub fn list_active_locks_url(c: &Client) -> Url {
    let mut u = c.rest_url("locks");
    u.set_query(Some("select=*&released_at=is.null"));
    u
}

impl Client {
    pub async fn acquire_lock(&self, file_id: FileId) -> Result<Lock, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = build_acquire_lock_body(file_id, UserId::from(session.user_id));
        let res = self
            .http()
            .post(acquire_lock_url(self))
            .header("apikey", self.anon_key())
            .header("Prefer", "return=representation")
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        let mut locks: Vec<Lock> = res.json().await?;
        locks.pop().ok_or(ClientError::Server { status: 200, body: "expected exactly one lock".into() })
    }

    pub async fn release_lock(&self, lock_id: LockId) -> Result<(), ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        // TODO: backend-side now() — currently the client clock is the source of
        // truth for released_at; a separate finding tracks switching to server now().
        let body = build_release_lock_body();
        let res = self
            .http()
            .patch(release_lock_url(self, lock_id))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .header("Prefer", RELEASE_LOCK_PREFER_HEADER)
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        // With released_at=is.null filter + Prefer: return=representation, an
        // empty array means another client already released this lock.
        let rows: Vec<Value> = res.json().await?;
        if rows.is_empty() {
            return Err(ClientError::LockAlreadyReleased(lock_id));
        }
        Ok(())
    }

    pub async fn list_active_locks(&self) -> Result<Vec<Lock>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_active_locks_url(self))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
