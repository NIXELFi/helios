use crate::error::ClientError;
use reqwest::Client as Http;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use url::Url;

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    base: Url,
    anon_key: String,
    http: Http,
    session: Mutex<Option<Session>>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: uuid::Uuid,
}

impl Client {
    // TODO: convert to Result<Url, ClientError> if dynamic identifiers are ever supported.
    pub fn rest_url(&self, table: &str) -> Url {
        // Caller contract: table/rpc names must be URL-safe identifiers (verified by unit test).
        self.inner.base.join(&format!("rest/v1/{}", table)).expect("valid table name")
    }

    pub fn rpc_url(&self, name: &str) -> Url {
        // Caller contract: table/rpc names must be URL-safe identifiers (verified by unit test).
        self.inner.base.join(&format!("rest/v1/rpc/{}", name)).expect("valid rpc name")
    }

    /// Base URL of the Supabase project, always with a trailing `/` so callers
    /// can use `.join("auth/v1/token")` style relative paths and preserve any
    /// path prefix (e.g. `https://host/supabase/`).
    pub fn base(&self) -> &Url {
        &self.inner.base
    }

    pub fn anon_key(&self) -> &str {
        &self.inner.anon_key
    }

    pub fn http(&self) -> &Http {
        &self.inner.http
    }

    pub fn session(&self) -> Option<Session> {
        self.inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn set_session(&self, s: Option<Session>) {
        *self.inner.session.lock().unwrap_or_else(|e| e.into_inner()) = s;
    }
}

#[derive(Default)]
pub struct ClientBuilder {
    url: Option<String>,
    anon_key: Option<String>,
}

impl ClientBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }

    pub fn anon_key(mut self, key: impl Into<String>) -> Self {
        self.anon_key = Some(key.into());
        self
    }

    pub fn build(self) -> Result<Client, ClientError> {
        let url = self.url.ok_or_else(|| ClientError::Config("url is required".into()))?;
        let anon_key = self.anon_key.ok_or_else(|| ClientError::Config("anon_key is required".into()))?;
        let mut base = Url::parse(&url)?;
        // Ensure base ends with '/' so .join() puts segments after it correctly.
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let http = Http::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Client {
            inner: Arc::new(Inner {
                base,
                anon_key,
                http,
                session: Mutex::new(None),
            }),
        })
    }
}
