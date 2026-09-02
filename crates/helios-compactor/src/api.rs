//! Supabase REST + Storage client (service role). All writes are confined to
//! schema `telemetry` and bucket `telemetry-sessions` (handoff §5.5).

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;
use serde_json::json;

use crate::compact::StagingRow;

pub const BUCKET: &str = "telemetry-sessions";

pub struct Api {
    http: reqwest::Client,
    base: String,
    key: String,
}

#[derive(Debug, Deserialize)]
pub struct SessionStatus {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct ObjectInfo {
    pub name: String,
}

impl Api {
    pub fn new(base: &str, service_role_key: &str) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert("apikey", HeaderValue::from_str(service_role_key)?);
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {service_role_key}"))?,
        );
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            key: service_role_key.to_string(),
        })
    }

    fn rest(&self, path: &str) -> String {
        format!("{}/rest/v1/{path}", self.base)
    }

    /// Uncompacted rows older than the settling delay, oldest first.
    pub async fn fetch_pending(&self, settle_s: u32, limit: u32) -> Result<Vec<StagingRow>> {
        let cutoff = chrono::Utc::now() - chrono::Duration::seconds(settle_s as i64);
        // Z-suffix form: rfc3339's "+00:00" decodes as a space in a URL query
        let url = self.rest(&format!(
            "staging_chunks?compacted_at=is.null&created_at=lt.{}&order=session_id,group_key,seq&limit={limit}&select=session_id,group_key,seq,t_start_us,payload,sample_count,created_at",
            cutoff.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
        ));
        let res = self
            .http
            .get(url)
            .header("Accept-Profile", "telemetry")
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("fetch_pending: HTTP {} {}", res.status(), res.text().await?);
        }
        Ok(res.json().await?)
    }

    pub async fn session_statuses(&self, ids: &[&str]) -> Result<HashMap<String, String>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let url = self.rest(&format!(
            "sessions?id=in.({})&select=id,status",
            ids.join(",")
        ));
        let res = self
            .http
            .get(url)
            .header("Accept-Profile", "telemetry")
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("session_statuses: HTTP {} {}", res.status(), res.text().await?);
        }
        let rows: Vec<SessionStatus> = res.json().await?;
        Ok(rows.into_iter().map(|s| (s.id, s.status)).collect())
    }

    /// Upsert-upload then verify size by reading the object's metadata back.
    /// Only after this returns Ok may rows be marked compacted.
    pub async fn upload_verified(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        let len = bytes.len() as u64;
        let url = format!("{}/storage/v1/object/{BUCKET}/{key}", self.base);
        let res = self
            .http
            .post(&url)
            .header("x-upsert", "true")
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("upload {key}: HTTP {} {}", res.status(), res.text().await?);
        }
        let info = self
            .http
            .get(format!("{}/storage/v1/object/info/{BUCKET}/{key}", self.base))
            .send()
            .await?;
        if !info.status().is_success() {
            bail!("verify {key}: HTTP {}", info.status());
        }
        let meta: serde_json::Value = info.json().await?;
        let got = meta
            .get("size")
            .and_then(|s| s.as_u64())
            .or_else(|| {
                meta.get("metadata")
                    .and_then(|m| m.get("size"))
                    .and_then(|s| s.as_u64())
            })
            .context("object info has no size")?;
        if got != len {
            bail!("verify {key}: uploaded {len} bytes but object reports {got}");
        }
        Ok(())
    }

    /// Marks exactly these seqs compacted (never a blind range: a late retry
    /// landing inside the range must not be marked without being in parquet).
    pub async fn mark_compacted(
        &self,
        session_id: &str,
        group_key: i32,
        seqs: &[i64],
    ) -> Result<()> {
        let seq_list = seqs
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let url = self.rest(&format!(
            "staging_chunks?session_id=eq.{session_id}&group_key=eq.{group_key}&seq=in.({seq_list})"
        ));
        let res = self
            .http
            .patch(url)
            .header("Content-Profile", "telemetry")
            .json(&json!({ "compacted_at": chrono::Utc::now().to_rfc3339() }))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("mark_compacted: HTTP {} {}", res.status(), res.text().await?);
        }
        Ok(())
    }

    pub async fn insert_downsampled(
        &self,
        session_id: &str,
        group_key: i32,
        t_start_us: i64,
        duration_s: i64,
        ipc_hex: &str,
    ) -> Result<()> {
        let res = self
            .http
            .post(self.rest("downsampled_1hz"))
            .header("Content-Profile", "telemetry")
            .header("Prefer", "resolution=merge-duplicates")
            .json(&json!({
                "session_id": session_id,
                "group_key": group_key,
                "t_start_us": t_start_us,
                "duration_s": duration_s,
                "payload": ipc_hex,
            }))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("insert_downsampled: HTTP {} {}", res.status(), res.text().await?);
        }
        Ok(())
    }

    /// Compactor-side retention fallback (pg_cron owns this when installed).
    pub async fn prune_staging(&self) -> Result<i64> {
        let res = self
            .http
            .post(self.rest("rpc/prune_staging"))
            .header("Content-Profile", "telemetry")
            .json(&json!({}))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("prune_staging: HTTP {} {}", res.status(), res.text().await?);
        }
        Ok(res.json().await.unwrap_or(0))
    }

    pub async fn list_objects(&self, prefix: &str) -> Result<Vec<ObjectInfo>> {
        let res = self
            .http
            .post(format!("{}/storage/v1/object/list/{BUCKET}", self.base))
            .json(&json!({ "prefix": prefix, "limit": 1000 }))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("list {prefix}: HTTP {} {}", res.status(), res.text().await?);
        }
        Ok(res.json().await?)
    }

    pub async fn download_object(&self, key: &str) -> Result<Vec<u8>> {
        let res = self
            .http
            .get(format!("{}/storage/v1/object/{BUCKET}/{key}", self.base))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("download {key}: HTTP {}", res.status());
        }
        Ok(res.bytes().await?.to_vec())
    }

    /// channel_sets.definition for the verify integrity diff.
    pub async fn channel_set(&self, id: i64) -> Result<serde_json::Value> {
        let res = self
            .http
            .get(self.rest(&format!("channel_sets?id=eq.{id}&select=definition")))
            .header("Accept-Profile", "telemetry")
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("channel_set: HTTP {}", res.status());
        }
        let mut rows: Vec<serde_json::Value> = res.json().await?;
        if rows.is_empty() {
            bail!("channel_set {id} not found");
        }
        Ok(rows.remove(0)["definition"].take())
    }

    pub fn key(&self) -> &str {
        &self.key
    }
}
