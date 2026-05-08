use pdm_client::{Client, ClientBuilder};
use pdm_client::check_in::{check_in_url, build_check_in_body};
use pdm_client::cancel::{cancel_checkout_url, build_cancel_body};
use pdm_client::force_unlock::{force_unlock_url, build_force_unlock_body};
use pdm_core::{FileId, LockId, Sha256};

fn c() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn check_in_url_is_rpc_pdm_check_in() {
    assert_eq!(
        check_in_url(&c()).as_str(),
        "https://example.supabase.co/rest/v1/rpc/pdm_check_in"
    );
}

#[test]
fn check_in_body_uses_p_prefixed_param_names() {
    let f = FileId::new();
    let s: Sha256 = "a".repeat(64).parse().unwrap();
    let body = build_check_in_body(f, &s, 1234, Some("first cut"));
    assert_eq!(body["p_file_id"], serde_json::json!(f));
    assert_eq!(body["p_sha256"], serde_json::json!(s));
    assert_eq!(body["p_size"], 1234);
    assert_eq!(body["p_comment"], "first cut");
}

#[test]
fn check_in_body_passes_null_for_missing_comment() {
    let f = FileId::new();
    let s: Sha256 = "a".repeat(64).parse().unwrap();
    let body = build_check_in_body(f, &s, 1, None);
    assert!(body["p_comment"].is_null());
}

#[test]
fn cancel_checkout_url_and_body() {
    let f = FileId::new();
    assert_eq!(
        cancel_checkout_url(&c()).as_str(),
        "https://example.supabase.co/rest/v1/rpc/pdm_cancel_checkout"
    );
    let body = build_cancel_body(f);
    assert_eq!(body["p_file_id"], serde_json::json!(f));
}

#[test]
fn force_unlock_url_and_body() {
    let l = LockId::new();
    assert_eq!(
        force_unlock_url(&c()).as_str(),
        "https://example.supabase.co/rest/v1/rpc/pdm_force_unlock"
    );
    let body = build_force_unlock_body(l, "left for the day");
    assert_eq!(body["p_lock_id"], serde_json::json!(l));
    assert_eq!(body["p_reason"], "left for the day");
}
