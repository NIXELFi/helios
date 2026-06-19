#![allow(unused_imports)]

use chrono::Utc;
use pdm_core::{AuditAction, AuditEntry, FileId, LockId, UserId, VersionId};
use serde_json::json;

#[test]
fn action_round_trips_through_postgres_strings() {
    use AuditAction::*;
    for (a, s) in [
        (CheckOut, "check_out"),
        (CheckIn, "check_in"),
        (CancelCheckout, "cancel_checkout"),
        (ForceUnlock, "force_unlock"),
        (ParseRefsFailed, "parse_refs_failed"),
    ] {
        let serialized = serde_json::to_value(a).unwrap();
        assert_eq!(serialized, json!(s));
        let back: AuditAction = serde_json::from_value(json!(s)).unwrap();
        assert_eq!(back, a);
    }
}

#[test]
fn entry_round_trips_with_jsonb_payload() {
    let entry = AuditEntry {
        id: 42,
        user_id: Some(UserId::new()),
        action: AuditAction::ForceUnlock,
        target_type: "lock".to_string(),
        target_id: LockId::new().to_string(),
        payload: Some(json!({"reason": "left for the day"})),
        ts: Utc::now(),
    };
    let s = serde_json::to_string(&entry).unwrap();
    let back: AuditEntry = serde_json::from_str(&s).unwrap();
    assert_eq!(back, entry);
}

#[test]
fn check_in_target_type_is_version_in_postgres() {
    // The Postgres trigger writes target_type='version' for check_in.
    // This test documents the convention; if the trigger changes, the assertion below changes.
    assert_eq!(AuditAction::CheckIn.canonical_target_type(), "version");
    assert_eq!(AuditAction::CheckOut.canonical_target_type(), "lock");
    assert_eq!(AuditAction::ForceUnlock.canonical_target_type(), "lock");
    assert_eq!(AuditAction::CancelCheckout.canonical_target_type(), "lock");
}

// ── M22: new action variants added to cover all DB-written strings ───────────

#[test]
fn all_db_action_strings_deserialize_to_correct_variant() {
    use AuditAction::*;
    // Every string the Postgres triggers/RPCs actually write to audit_log.action.
    for (action, s) in [
        (LockReleased, "lock_released"),
        (SetRevision, "set_revision"),
        (RestoreVersion, "restore_version"),
        (Delete, "delete"),
        (Restore, "restore"),
        (FileCreate, "file_create"),
        (FileRename, "file_rename"),
        (FileMove, "file_move"),
        (FileDelete, "file_delete"),
        (FolderCreate, "folder_create"),
        (FolderRename, "folder_rename"),
        (FolderMove, "folder_move"),
        (FolderDelete, "folder_delete"),
        (RoleGrant, "role_grant"),
        (RoleChange, "role_change"),
        (RoleRevoke, "role_revoke"),
    ] {
        let back: AuditAction = serde_json::from_value(json!(s))
            .unwrap_or_else(|e| panic!("failed to deserialize '{}': {}", s, e));
        assert_eq!(back, action, "mismatch for DB string '{}'", s);
    }
}

#[test]
fn unknown_action_string_deserializes_to_other() {
    // Forward-compat: an action string we don't know about must NOT panic/error.
    let back: AuditAction = serde_json::from_value(json!("some_future_action")).unwrap();
    assert_eq!(back, AuditAction::Other);

    let back2: AuditAction = serde_json::from_value(json!("totally_unknown_xyz")).unwrap();
    assert_eq!(back2, AuditAction::Other);
}

#[test]
fn other_variant_canonical_target_type_is_unknown() {
    assert_eq!(AuditAction::Other.canonical_target_type(), "unknown");
}

#[test]
fn new_variants_have_correct_canonical_target_types() {
    use AuditAction::*;
    // lock
    assert_eq!(LockReleased.canonical_target_type(), "lock");
    // version
    assert_eq!(SetRevision.canonical_target_type(), "version");
    assert_eq!(RestoreVersion.canonical_target_type(), "version");
    // file (soft-delete RPCs)
    assert_eq!(Delete.canonical_target_type(), "file");
    assert_eq!(Restore.canonical_target_type(), "file");
    // structural file
    assert_eq!(FileCreate.canonical_target_type(), "file");
    assert_eq!(FileRename.canonical_target_type(), "file");
    assert_eq!(FileMove.canonical_target_type(), "file");
    assert_eq!(FileDelete.canonical_target_type(), "file");
    // structural folder
    assert_eq!(FolderCreate.canonical_target_type(), "folder");
    assert_eq!(FolderRename.canonical_target_type(), "folder");
    assert_eq!(FolderMove.canonical_target_type(), "folder");
    assert_eq!(FolderDelete.canonical_target_type(), "folder");
    // role lifecycle
    assert_eq!(RoleGrant.canonical_target_type(), "user_role");
    assert_eq!(RoleChange.canonical_target_type(), "user_role");
    assert_eq!(RoleRevoke.canonical_target_type(), "user_role");
}

#[test]
fn audit_entry_with_delete_action_round_trips() {
    let entry = AuditEntry {
        id: 99,
        user_id: Some(UserId::new()),
        action: AuditAction::Delete,
        target_type: "file".to_string(),
        target_id: FileId::new().to_string(),
        payload: Some(json!({"soft": true})),
        ts: Utc::now(),
    };
    let s = serde_json::to_string(&entry).unwrap();
    let back: AuditEntry = serde_json::from_str(&s).unwrap();
    assert_eq!(back, entry);
    assert_eq!(back.action, AuditAction::Delete);
}
