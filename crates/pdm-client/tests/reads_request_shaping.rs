use pdm_client::{Client, ClientBuilder};
use pdm_client::vaults::list_vaults_url;
use pdm_client::folders::list_folders_url;
use pdm_client::files::list_files_url;
use pdm_client::versions::list_versions_url;
use pdm_core::{FileId, FolderId, VaultId};

fn mkclient() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn list_vaults_hits_rest_v1_vaults() {
    let u = list_vaults_url(&mkclient());
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/vaults?select=*");
}

#[test]
fn list_folders_filters_by_vault_id() {
    let v = VaultId::new();
    let u = list_folders_url(&mkclient(), v);
    let s = u.as_str();
    assert!(s.starts_with("https://example.supabase.co/rest/v1/folders?"));
    assert!(s.contains("vault_id=eq."));
    assert!(s.contains(&v.to_string()));
    assert!(s.contains("select=*"));
}

#[test]
fn list_files_filters_by_folder_id() {
    let f = FolderId::new();
    let u = list_files_url(&mkclient(), f);
    let s = u.as_str();
    assert!(s.contains("folder_id=eq."));
    assert!(s.contains(&f.to_string()));
}

#[test]
fn list_versions_filters_by_file_id_and_orders_desc() {
    let f = FileId::new();
    let u = list_versions_url(&mkclient(), f);
    let s = u.as_str();
    assert!(s.contains("file_id=eq."));
    assert!(s.contains(&f.to_string()));
    assert!(s.contains("order=version_num.desc"));
}
