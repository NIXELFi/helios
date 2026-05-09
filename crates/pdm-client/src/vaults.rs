use crate::client::Client;
use crate::error::ClientError;
use pdm_core::Vault;
use url::Url;

pub fn list_vaults_url(c: &Client) -> Url {
    let mut u = c.rest_url("vaults");
    u.set_query(Some("select=*"));
    u
}

impl Client {
    pub async fn list_vaults(&self) -> Result<Vec<Vault>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_vaults_url(self))
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
