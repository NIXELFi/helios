use pdm_client::{Client, ClientBuilder};

#[test]
fn builder_requires_url_and_anon_key() {
    let r = ClientBuilder::new()
        .url("https://example.supabase.co")
        .anon_key("anon-k")
        .build();
    assert!(r.is_ok());
}

#[test]
fn builder_rejects_missing_url() {
    let r = ClientBuilder::new().anon_key("anon-k").build();
    assert!(r.is_err());
}

#[test]
fn builder_rejects_missing_anon_key() {
    let r = ClientBuilder::new().url("https://example.supabase.co").build();
    assert!(r.is_err());
}

#[test]
fn rest_url_for_table_is_correctly_constructed() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co")
        .anon_key("k")
        .build()
        .unwrap();
    let u = c.rest_url("vaults");
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/vaults");
}

#[test]
fn rpc_url_is_correctly_constructed() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co/")
        .anon_key("k")
        .build()
        .unwrap();
    let u = c.rpc_url("pdm_check_in");
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/rpc/pdm_check_in");
}
