use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{Folder, VaultId};
use url::Url;

pub fn list_folders_url(c: &Client, vault_id: VaultId) -> Url {
    let mut u = c.rest_url("folders");
    u.set_query(Some(&format!("vault_id=eq.{}&select=*", vault_id)));
    u
}

impl Client {
    pub async fn list_folders(&self, vault_id: VaultId) -> Result<Vec<Folder>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_folders_url(self, vault_id))
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
