use pdm_client::{Client, ClientBuilder};
use pdm_client::storage::{create_signed_upload_url_url, create_signed_download_url_url};
use pdm_core::Sha256;

fn c() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn signed_upload_url_endpoint() {
    let s: Sha256 = "a".repeat(64).parse().unwrap();
    let u = create_signed_upload_url_url(&c(), &s).unwrap();
    assert_eq!(
        u.as_str(),
        format!("https://example.supabase.co/storage/v1/object/upload/sign/vault-objects/{}", s.storage_path())
    );
}

#[test]
fn signed_download_url_endpoint() {
    let s: Sha256 = "b".repeat(64).parse().unwrap();
    let u = create_signed_download_url_url(&c(), &s).unwrap();
    assert_eq!(
        u.as_str(),
        format!("https://example.supabase.co/storage/v1/object/sign/vault-objects/{}", s.storage_path())
    );
}

#[test]
fn signed_urls_preserve_base_path_prefix() {
    let prefixed = ClientBuilder::new()
        .url("https://host.example/supabase/")
        .anon_key("k")
        .build()
        .unwrap();
    let s: Sha256 = "c".repeat(64).parse().unwrap();
    let up = create_signed_upload_url_url(&prefixed, &s).unwrap();
    assert_eq!(
        up.as_str(),
        format!(
            "https://host.example/supabase/storage/v1/object/upload/sign/vault-objects/{}",
            s.storage_path()
        )
    );
    let dn = create_signed_download_url_url(&prefixed, &s).unwrap();
    assert_eq!(
        dn.as_str(),
        format!(
            "https://host.example/supabase/storage/v1/object/sign/vault-objects/{}",
            s.storage_path()
        )
    );
}
