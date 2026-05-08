use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{File, FolderId};
use url::Url;

pub fn list_files_url(c: &Client, folder_id: FolderId) -> Url {
    let mut u = c.rest_url("files");
    u.set_query(Some(&format!("folder_id=eq.{}&select=*", folder_id)));
    u
}

impl Client {
    pub async fn list_files(&self, folder_id: FolderId) -> Result<Vec<File>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_files_url(self, folder_id))
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
