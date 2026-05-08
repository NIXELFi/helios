use crate::error::ClientError;
use reqwest::Client as Http;
use std::sync::{Arc, Mutex};
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
    pub fn rest_url(&self, table: &str) -> Url {
        self.inner.base.join(&format!("rest/v1/{}", table)).expect("valid table name")
    }

    pub fn rpc_url(&self, name: &str) -> Url {
        self.inner.base.join(&format!("rest/v1/rpc/{}", name)).expect("valid rpc name")
    }

    pub fn anon_key(&self) -> &str {
        &self.inner.anon_key
    }

    pub fn http(&self) -> &Http {
        &self.inner.http
    }

    pub fn session(&self) -> Option<Session> {
        self.inner.session.lock().expect("poisoned").clone()
    }

    pub(crate) fn set_session(&self, s: Option<Session>) {
        *self.inner.session.lock().expect("poisoned") = s;
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
        let http = Http::builder().build()?;
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
