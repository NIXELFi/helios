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
