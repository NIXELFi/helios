use crate::client::Client;
use crate::error::ClientError;
use pdm_core::FileId;
use serde_json::{json, Value};
use url::Url;

pub fn cancel_checkout_url(c: &Client) -> Url {
    c.rpc_url("pdm_cancel_checkout")
}

pub fn build_cancel_body(file_id: FileId) -> Value {
    json!({ "p_file_id": file_id })
}

impl Client {
    pub async fn cancel_checkout(&self, file_id: FileId) -> Result<(), ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .post(cancel_checkout_url(self))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&build_cancel_body(file_id))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(())
    }
}
