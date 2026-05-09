use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{FileId, Version};
use url::Url;

pub fn list_versions_url(c: &Client, file_id: FileId) -> Url {
    let mut u = c.rest_url("versions");
    u.set_query(Some(&format!("file_id=eq.{}&select=*&order=version_num.desc", file_id)));
    u
}

impl Client {
    pub async fn list_versions(&self, file_id: FileId) -> Result<Vec<Version>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_versions_url(self, file_id))
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
