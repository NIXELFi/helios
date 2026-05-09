use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{FileId, Sha256, Version};
use serde_json::{json, Value};
use url::Url;

pub fn check_in_url(c: &Client) -> Url {
    c.rpc_url("pdm_check_in")
}

pub fn build_check_in_body(file_id: FileId, sha256: &Sha256, size: u64, comment: Option<&str>) -> Value {
    json!({
        "p_file_id": file_id,
        "p_sha256": sha256,
        "p_size": size,
        "p_comment": comment,
    })
}

impl Client {
    pub async fn check_in(
        &self,
        file_id: FileId,
        sha256: &Sha256,
        size: u64,
        comment: Option<&str>,
    ) -> Result<Version, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = build_check_in_body(file_id, sha256, size, comment);
        let res = self
            .http()
            .post(check_in_url(self))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
