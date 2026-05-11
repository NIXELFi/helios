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

#[test]
fn base_url_preserves_path_prefix_when_present() {
    // If a project sits behind a reverse proxy at /supabase/, the prefix must
    // survive into REST and RPC URLs.
    let c = ClientBuilder::new()
        .url("https://host.example/supabase/")
        .anon_key("k")
        .build()
        .unwrap();
    let u = c.rest_url("vaults");
    assert_eq!(u.as_str(), "https://host.example/supabase/rest/v1/vaults");
    let u = c.rpc_url("pdm_check_in");
    assert_eq!(u.as_str(), "https://host.example/supabase/rest/v1/rpc/pdm_check_in");
    // And base() returns the URL with a trailing slash.
    assert!(c.base().path().ends_with('/'));
}

/// Caller-contract enforcement (finding #4): every identifier currently passed
/// to rest_url/rpc_url across this crate must round-trip through Url::join
/// without escaping. New callers must add their identifier here too.
#[test]
fn all_known_rest_and_rpc_identifiers_are_url_safe() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co/")
        .anon_key("k")
        .build()
        .unwrap();
    // REST tables used across the crate.
    let rest_tables = ["vaults", "folders", "files", "versions", "locks"];
    for t in rest_tables {
        let u = c.rest_url(t);
        assert!(
            u.path().ends_with(&format!("/rest/v1/{}", t)),
            "rest_url({:?}) -> {} did not round-trip clean",
            t,
            u.as_str()
        );
    }
    // RPCs used across the crate.
    let rpcs = ["pdm_check_in", "pdm_cancel_checkout", "pdm_force_unlock"];
    for r in rpcs {
        let u = c.rpc_url(r);
        assert!(
            u.path().ends_with(&format!("/rest/v1/rpc/{}", r)),
            "rpc_url({:?}) -> {} did not round-trip clean",
            r,
            u.as_str()
        );
    }
}
