use pdm_client::{Client, ClientBuilder};
use pdm_client::locks::{
    acquire_lock_url, list_active_locks_url, release_lock_url,
    build_acquire_lock_body,
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
fn list_active_locks_filters_by_released_at_is_null() {
    let url = list_active_locks_url(&c());
    let s = url.as_str();
    assert!(s.contains("released_at=is.null"));
}
