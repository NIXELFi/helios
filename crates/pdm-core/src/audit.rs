use crate::ids::UserId;
use alloc::borrow::ToOwned;
use alloc::string::String;
use chrono::{DateTime, Utc};
use core::fmt;
use serde::de::{self, Deserializer, Visitor};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

/// Every action string the Postgres triggers / RPCs write to `pdm.audit_log.action`.
///
/// Known variants map 1-to-1 with the DB string (snake_case).  `Other(String)` is a
/// forward-compatibility catch-all: any action string not listed here deserializes to
/// `Other("the_raw_string")` instead of returning a hard error, and — crucially —
/// serializes *back* to that same raw string, so an `AuditEntry` carrying an unknown
/// action round-trips losslessly (read from the DB -> send to the UI/cache) instead of
/// panicking on re-serialization.  (De)serialization is implemented manually below
/// precisely so `Other` can carry and re-emit the original value.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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
    /// Any action string not recognised by this version of the crate, with the
    /// original Postgres string preserved.  Avoids hard deserialization failures
    /// when new actions are added to the DB before the crate is updated, and
    /// re-serializes to the preserved string so entries round-trip losslessly.
    Other(String),
}

impl AuditAction {
    /// The wire / Postgres `action` string for this variant.  Known variants use
    /// their snake_case name; `Other` returns the preserved original string.
    pub fn as_str(&self) -> &str {
        match self {
            AuditAction::CheckOut => "check_out",
            AuditAction::CheckIn => "check_in",
            AuditAction::CancelCheckout => "cancel_checkout",
            AuditAction::ForceUnlock => "force_unlock",
            AuditAction::LockReleased => "lock_released",
            AuditAction::SetRevision => "set_revision",
            AuditAction::RestoreVersion => "restore_version",
            AuditAction::ParseRefsFailed => "parse_refs_failed",
            AuditAction::Delete => "delete",
            AuditAction::Restore => "restore",
            AuditAction::FileCreate => "file_create",
            AuditAction::FileRename => "file_rename",
            AuditAction::FileMove => "file_move",
            AuditAction::FileDelete => "file_delete",
            AuditAction::FolderCreate => "folder_create",
            AuditAction::FolderRename => "folder_rename",
            AuditAction::FolderMove => "folder_move",
            AuditAction::FolderDelete => "folder_delete",
            AuditAction::RoleGrant => "role_grant",
            AuditAction::RoleChange => "role_change",
            AuditAction::RoleRevoke => "role_revoke",
            AuditAction::Other(s) => s.as_str(),
        }
    }

    /// Map a wire / Postgres `action` string to a variant.  Unknown strings are
    /// preserved in `Other` rather than rejected.
    pub fn from_wire(s: &str) -> AuditAction {
        match s {
            "check_out" => AuditAction::CheckOut,
            "check_in" => AuditAction::CheckIn,
            "cancel_checkout" => AuditAction::CancelCheckout,
            "force_unlock" => AuditAction::ForceUnlock,
            "lock_released" => AuditAction::LockReleased,
            "set_revision" => AuditAction::SetRevision,
            "restore_version" => AuditAction::RestoreVersion,
            "parse_refs_failed" => AuditAction::ParseRefsFailed,
            "delete" => AuditAction::Delete,
            "restore" => AuditAction::Restore,
            "file_create" => AuditAction::FileCreate,
            "file_rename" => AuditAction::FileRename,
            "file_move" => AuditAction::FileMove,
            "file_delete" => AuditAction::FileDelete,
            "folder_create" => AuditAction::FolderCreate,
            "folder_rename" => AuditAction::FolderRename,
            "folder_move" => AuditAction::FolderMove,
            "folder_delete" => AuditAction::FolderDelete,
            "role_grant" => AuditAction::RoleGrant,
            "role_change" => AuditAction::RoleChange,
            "role_revoke" => AuditAction::RoleRevoke,
            other => AuditAction::Other(other.to_owned()),
        }
    }
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
    pub fn canonical_target_type(&self) -> &'static str {
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
            AuditAction::Other(_) => "unknown",
        }
    }
}

// Manual (de)serialization so the `Other(String)` catch-all round-trips losslessly:
// a known variant (de)serializes via its snake_case wire string, and an unknown
// string is preserved in `Other` and re-emitted verbatim — serialization can never
// fail or panic on an entry read from a newer database.
impl Serialize for AuditAction {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AuditAction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ActionVisitor;
        impl Visitor<'_> for ActionVisitor {
            type Value = AuditAction;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an audit action string")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<AuditAction, E> {
                Ok(AuditAction::from_wire(v))
            }
        }
        deserializer.deserialize_str(ActionVisitor)
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
