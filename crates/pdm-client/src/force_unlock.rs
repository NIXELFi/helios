use crate::client::Client;
use crate::error::ClientError;
use pdm_core::LockId;
use serde_json::{json, Value};
use url::Url;

pub fn force_unlock_url(c: &Client) -> Url {
    c.rpc_url("pdm_force_unlock")
}

pub fn build_force_unlock_body(lock_id: LockId, reason: &str) -> Value {
    json!({ "p_lock_id": lock_id, "p_reason": reason })
}

impl Client {
    pub async fn force_unlock(&self, lock_id: LockId, reason: &str) -> Result<(), ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .post(force_unlock_url(self))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&build_force_unlock_body(lock_id, reason))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(())
    }
}
