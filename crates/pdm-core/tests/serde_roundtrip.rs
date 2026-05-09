use chrono::Utc;
use pdm_core::{
    File, FileId, Folder, FolderId, Lock, LockId, Ref, Sha256, UserId, Vault, VaultId, Version,
    VersionId,
};

fn sha() -> Sha256 {
    "0".repeat(64).parse().unwrap()
}

#[test]
fn vault_round_trips_through_json() {
    let v = Vault {
        id: VaultId::new(),
        name: "sdm26".to_string(),
        created_at: Utc::now(),
        created_by: UserId::new(),
    };
    let s = serde_json::to_string(&v).unwrap();
    let back: Vault = serde_json::from_str(&s).unwrap();
    assert_eq!(back, v);
}

#[test]
fn folder_round_trips() {
    let f = Folder {
        id: FolderId::new(),
        vault_id: VaultId::new(),
        parent_id: None,
        name: "chassis".to_string(),
        created_at: Utc::now(),
    };
    let s = serde_json::to_string(&f).unwrap();
    let back: Folder = serde_json::from_str(&s).unwrap();
    assert_eq!(back, f);
}

#[test]
fn file_round_trips() {
    let file = File {
        id: FileId::new(),
        vault_id: VaultId::new(),
        folder_id: Some(FolderId::new()),
        name: "frame.sldprt".to_string(),
        latest_version_id: Some(VersionId::new()),
        created_at: Utc::now(),
    };
    let s = serde_json::to_string(&file).unwrap();
    let back: File = serde_json::from_str(&s).unwrap();
    assert_eq!(back, file);
}

#[test]
fn version_round_trips() {
    let v = Version {
        id: VersionId::new(),
        file_id: FileId::new(),
        version_num: 7,
        sha256: sha(),
        size_bytes: 1234,
        author_id: UserId::new(),
        comment: Some("first cut".to_string()),
        parent_version_id: None,
        created_at: Utc::now(),
    };
    let s = serde_json::to_string(&v).unwrap();
    let back: Version = serde_json::from_str(&s).unwrap();
    assert_eq!(back, v);
}

#[test]
fn lock_round_trips_with_active_state() {
    let l = Lock {
        id: LockId::new(),
        file_id: FileId::new(),
        user_id: UserId::new(),
        acquired_at: Utc::now(),
        released_at: None,
        force_released_by: None,
    };
    let s = serde_json::to_string(&l).unwrap();
    let back: Lock = serde_json::from_str(&s).unwrap();
    assert_eq!(back, l);
    assert!(l.is_active());
}

#[test]
fn lock_is_active_returns_false_when_released() {
    let l = Lock {
        id: LockId::new(),
        file_id: FileId::new(),
        user_id: UserId::new(),
        acquired_at: Utc::now(),
        released_at: Some(Utc::now()),
        force_released_by: None,
    };
    assert!(!l.is_active());
}

#[test]
fn ref_round_trips() {
    let r = Ref {
        parent_version_id: VersionId::new(),
        child_path_hint: "..\\parts\\frame-rail.sldprt".to_string(),
        child_file_id: Some(FileId::new()),
    };
    let s = serde_json::to_string(&r).unwrap();
    let back: Ref = serde_json::from_str(&s).unwrap();
    assert_eq!(back, r);
}
