use crate::ids::UserId;
use alloc::string::String;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    CheckOut,
    CheckIn,
    CancelCheckout,
    ForceUnlock,
    ParseRefsFailed,
}

impl AuditAction {
    /// What `pdm.audit_log.target_type` the Postgres triggers / RPCs use for this action.
    /// Matches the conventions defined in migration `20260507000900_pdm_audit_triggers.sql`.
    pub fn canonical_target_type(self) -> &'static str {
        match self {
            AuditAction::CheckOut => "lock",
            AuditAction::CheckIn => "version",
            AuditAction::CancelCheckout => "lock",
            AuditAction::ForceUnlock => "lock",
            AuditAction::ParseRefsFailed => "version",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: i64,
    pub user_id: Option<UserId>,
    pub action: AuditAction,
    pub target_type: String,
    pub target_id: String,
    pub payload: Option<serde_json::Value>,
    pub ts: DateTime<Utc>,
}
