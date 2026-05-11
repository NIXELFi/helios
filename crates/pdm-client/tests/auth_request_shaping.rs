use pdm_client::{Client, ClientBuilder};
use pdm_client::auth::{SignInRequest, build_sign_in_body, build_sign_in_url};

#[test]
fn sign_in_url_is_under_auth_v1_token_grant_type_password() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co")
        .anon_key("anon")
        .build()
        .unwrap();
    let u = build_sign_in_url(&c).unwrap();
    assert_eq!(
        u.as_str(),
        "https://example.supabase.co/auth/v1/token?grant_type=password"
    );
}

#[test]
fn sign_in_url_preserves_base_path_prefix() {
    let c = ClientBuilder::new()
        .url("https://host.example/supabase/")
        .anon_key("anon")
        .build()
        .unwrap();
    let u = build_sign_in_url(&c).unwrap();
    assert_eq!(
        u.as_str(),
        "https://host.example/supabase/auth/v1/token?grant_type=password"
    );
}

#[test]
fn sign_in_body_serializes_to_email_and_password() {
    let body = build_sign_in_body(&SignInRequest {
        email: "me@example.com".into(),
        password: "hunter2".into(),
    });
    assert_eq!(body["email"], "me@example.com");
    assert_eq!(body["password"], "hunter2");
}
