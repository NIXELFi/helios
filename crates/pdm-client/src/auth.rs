use crate::client::{Client, Session};
use crate::error::ClientError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct SignInRequest {
    pub email: String,
    pub password: String,
}

pub fn build_sign_in_url(c: &Client) -> Result<Url, ClientError> {
    let mut u = c.base().join("auth/v1/token")?;
    u.set_query(Some("grant_type=password"));
    Ok(u)
}

pub fn build_sign_in_body(req: &SignInRequest) -> Value {
    serde_json::json!({ "email": req.email, "password": req.password })
}

#[derive(Debug, Deserialize)]
struct GoTrueResponse {
    access_token: String,
    refresh_token: String,
    user: GoTrueUser,
}

#[derive(Debug, Deserialize)]
struct GoTrueUser {
    id: uuid::Uuid,
}

impl Client {
    pub async fn sign_in(&self, req: SignInRequest) -> Result<Session, ClientError> {
        let url = build_sign_in_url(self)?;
        let body = build_sign_in_body(&req);
        let res = self
            .http()
            .post(url)
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(ClientError::Server { status, body });
        }
        let parsed: GoTrueResponse = res.json().await?;
        let s = Session {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            user_id: parsed.user.id,
        };
        self.set_session(Some(s.clone()));
        Ok(s)
    }

    pub async fn sign_out(&self) -> Result<(), ClientError> {
        // Best-effort: server has a /logout endpoint that revokes refresh tokens,
        // but for client purposes clearing the local session is sufficient.
        self.set_session(None);
        Ok(())
    }
}
