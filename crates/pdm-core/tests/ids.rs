use pdm_core::{CoreError, FileId, FolderId, LockId, UserId, VaultId, VersionId};
use uuid::Uuid;

#[test]
fn uuid_newtypes_round_trip_through_string() {
    let raw = Uuid::new_v4();
    let v: VaultId = raw.into();
    assert_eq!(v.as_uuid(), &raw);
    let s = v.to_string();
    let parsed: VaultId = s.parse().expect("must parse");
    assert_eq!(parsed, v);
}

#[test]
fn invalid_string_returns_invalid_id_error() {
    let err = "not-a-uuid".parse::<FileId>().unwrap_err();
    assert!(matches!(err, CoreError::InvalidId(_)), "expected InvalidId, got {:?}", err);
}

#[test]
fn newtypes_are_distinct() {
    // Compile-only check that FileId != FolderId — uncomment to verify it's a compile error:
    // let f: FileId = FolderId::from(Uuid::new_v4());

    // Runtime check: serde produces same underlying string for both, but they are not interchangeable.
    let raw = Uuid::new_v4();
    let f: FileId = raw.into();
    let d: FolderId = raw.into();
    assert_eq!(f.to_string(), d.to_string());
}

#[test]
fn folder_id_lock_id_user_id_version_id_all_present() {
    // Smoke test that every newtype constructs.
    let _: FolderId = Uuid::new_v4().into();
    let _: LockId = Uuid::new_v4().into();
    let _: UserId = Uuid::new_v4().into();
    let _: VersionId = Uuid::new_v4().into();
}
