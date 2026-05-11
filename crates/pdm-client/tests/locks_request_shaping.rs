use pdm_client::{Client, ClientBuilder};
use pdm_client::locks::{
    acquire_lock_url, list_active_locks_url, release_lock_url,
    build_acquire_lock_body, build_release_lock_body, RELEASE_LOCK_PREFER_HEADER,
};
use pdm_core::{FileId, LockId, UserId};

fn c() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn acquire_lock_posts_to_locks_table() {
    let u = acquire_lock_url(&c());
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/locks");
}

#[test]
fn acquire_lock_body_has_file_id_and_user_id() {
    let f = FileId::new();
    let u = UserId::new();
    let body = build_acquire_lock_body(f, u);
    assert_eq!(body["file_id"], serde_json::json!(f));
    assert_eq!(body["user_id"], serde_json::json!(u));
}

#[test]
fn release_lock_url_filters_by_lock_id() {
    let l = LockId::new();
    let url = release_lock_url(&c(), l);
    let s = url.as_str();
    assert!(s.starts_with("https://example.supabase.co/rest/v1/locks?"));
    assert!(s.contains("id=eq."));
    assert!(s.contains(&l.to_string()));
}

#[test]
fn release_lock_url_filters_by_released_at_is_null() {
    // Concurrency guard: only release a lock currently held (released_at IS NULL)
    // so racing clients can detect that another client beat them.
    let l = LockId::new();
    let url = release_lock_url(&c(), l);
    let s = url.as_str();
    assert!(
        s.contains("released_at=is.null"),
        "release_lock_url must include released_at=is.null filter; got {}",
        s
    );
}

#[test]
fn release_lock_prefer_header_is_return_representation() {
    // Required so PostgREST returns the updated rows; an empty array tells us
    // the lock was already released by another client.
    assert_eq!(RELEASE_LOCK_PREFER_HEADER, "return=representation");
}

#[test]
fn release_lock_body_has_released_at() {
    let body = build_release_lock_body();
    assert!(
        body.get("released_at").is_some(),
        "release_lock body must include released_at; got {}",
        body
    );
}

#[test]
fn list_active_locks_filters_by_released_at_is_null() {
    let url = list_active_locks_url(&c());
    let s = url.as_str();
    assert!(s.contains("released_at=is.null"));
}
