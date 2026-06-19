use crate::ids::UserId;
use alloc::string::String;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Every action string the Postgres triggers / RPCs write to `pdm.audit_log.action`.
///
/// Variants map 1-to-1 with the DB string via `#[serde(rename_all = "snake_case")]`.
/// `Other` is a forward-compatibility catch-all: any action string not listed here
/// deserializes to `Other` instead of returning a hard error (`#[serde(other)]`).
///
/// Note: `Other` cannot carry the original string because `#[serde(other)]` requires
/// a unit variant.  Callers that need the raw string should read `AuditEntry.target_type`
/// or the raw JSON before deserializing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    // ── lock lifecycle ───────────────────────────────────────────────────────
    /// File checked out (lock created). target_type = "lock"
    CheckOut,
    /// File checked in (lock released + new version). target_type = "version"
    CheckIn,
    /// Checkout cancelled by the owning user. target_type = "lock"
    CancelCheckout,
    /// Lock force-released by an admin. target_type = "lock"
    ForceUnlock,
    /// Lock released via direct UPDATE (service-role or future code path). target_type = "lock"
    LockReleased,

    // ── version operations ───────────────────────────────────────────────────
    /// Revision label bumped via set_revision RPC. target_type = "version"
    SetRevision,
    /// An old version promoted to latest via restore_version RPC. target_type = "version"
    RestoreVersion,
    /// Client-side failure to parse assembly refs; logged for observability. target_type = "version"
    ParseRefsFailed,

    // ── file lifecycle (soft-delete RPCs) ────────────────────────────────────
    /// Subject soft-deleted via pdm.delete_file or pdm.delete_folder RPC.
    ///
    /// The DB writes action `'delete'` for **both** files (delete_file) and
    /// folders (delete_folder), so this variant is emitted for either subject.
    /// `canonical_target_type` returns `"file"` as a convenience default; callers
    /// that need the actual subject type must read `AuditEntry.target_type`.
    Delete,
    /// Soft-deleted subject undeleted via pdm.restore_file or pdm.restore_folder RPC.
    ///
    /// The DB writes action `'restore'` for **both** files (restore_file) and
    /// folders (restore_folder), so this variant is emitted for either subject.
    /// `canonical_target_type` returns `"file"` as a convenience default; callers
    /// that need the actual subject type must read `AuditEntry.target_type`.
    Restore,

    // ── structural events (trg_files_audit) ──────────────────────────────────
    /// File row inserted. target_type = "file"
    FileCreate,
    /// File renamed. target_type = "file"
    FileRename,
    /// File moved to a different folder. target_type = "file"
    FileMove,
    /// File hard-deleted (row removed). target_type = "file"
    FileDelete,

    // ── structural events (trg_folders_audit) ────────────────────────────────
    /// Folder row inserted. target_type = "folder"
    FolderCreate,
    /// Folder renamed. target_type = "folder"
    FolderRename,
    /// Folder moved to a different parent. target_type = "folder"
    FolderMove,
    /// Folder hard-deleted (row removed). target_type = "folder"
    FolderDelete,

    // ── role lifecycle (trg_user_roles_audit) ────────────────────────────────
    /// Role assigned to a user. target_type = "user_role"
    RoleGrant,
    /// User's role changed to a different value. target_type = "user_role"
    RoleChange,
    /// Role removed from a user. target_type = "user_role"
    RoleRevoke,

    // ── forward-compatibility catch-all ──────────────────────────────────────
    /// Any action string not recognised by this version of the crate.
    /// Use this to avoid hard deserialization failures when new actions are
    /// added to the DB before the crate is updated.
    #[serde(other)]
    Other,
}

impl AuditAction {
    /// What `pdm.audit_log.target_type` the Postgres triggers / RPCs use for this action.
    /// Matches the conventions defined in migration `20260507000900_pdm_audit_triggers.sql`
    /// and subsequent structural-events / role migrations.
    ///
    /// Returns `"unknown"` for the forward-compat `Other` variant.
    ///
    /// **Caveat — `Delete` / `Restore`:** the DB emits `'delete'`/`'restore'` for
    /// both files *and* folders, so this function returns `"file"` for those variants
    /// as a convenience default only.  If you need the authoritative subject type,
    /// read `AuditEntry.target_type` directly instead of calling this method.
    pub fn canonical_target_type(self) -> &'static str {
        match self {
            // lock lifecycle
            AuditAction::CheckOut => "lock",
            AuditAction::CancelCheckout => "lock",
            AuditAction::ForceUnlock => "lock",
            AuditAction::LockReleased => "lock",
            // version operations
            AuditAction::CheckIn => "version",
            AuditAction::SetRevision => "version",
            AuditAction::RestoreVersion => "version",
            AuditAction::ParseRefsFailed => "version",
            // file soft-delete RPCs
            AuditAction::Delete => "file",
            AuditAction::Restore => "file",
            // structural file events
            AuditAction::FileCreate => "file",
            AuditAction::FileRename => "file",
            AuditAction::FileMove => "file",
            AuditAction::FileDelete => "file",
            // structural folder events
            AuditAction::FolderCreate => "folder",
            AuditAction::FolderRename => "folder",
            AuditAction::FolderMove => "folder",
            AuditAction::FolderDelete => "folder",
            // role lifecycle
            AuditAction::RoleGrant => "user_role",
            AuditAction::RoleChange => "user_role",
            AuditAction::RoleRevoke => "user_role",
            // forward-compat catch-all
            AuditAction::Other => "unknown",
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
