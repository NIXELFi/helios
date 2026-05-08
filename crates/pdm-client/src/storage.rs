use crate::client::Client;
use crate::error::ClientError;
use pdm_core::Sha256;
use serde::Deserialize;
use serde_json::json;
use url::Url;

pub const BUCKET: &str = "vault-objects";

pub fn create_signed_upload_url_url(c: &Client, sha: &Sha256) -> Url {
    let mut u = c.rest_url("x");
    u.set_path(&format!("storage/v1/object/upload/sign/{}/{}", BUCKET, sha.storage_path()));
    u
}

pub fn create_signed_download_url_url(c: &Client, sha: &Sha256) -> Url {
    let mut u = c.rest_url("x");
    u.set_path(&format!("storage/v1/object/sign/{}/{}", BUCKET, sha.storage_path()));
    u
}

#[derive(Debug, Deserialize)]
pub struct SignedUrl {
    pub url: String,
}

impl Client {
    pub async fn create_signed_upload_url(&self, sha: &Sha256) -> Result<SignedUrl, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .post(create_signed_upload_url_url(self, sha))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }

    pub async fn create_signed_download_url(&self, sha: &Sha256, expires_seconds: u64) -> Result<SignedUrl, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = json!({ "expiresIn": expires_seconds });
        let res = self
            .http()
            .post(create_signed_download_url_url(self, sha))
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
