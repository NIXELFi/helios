// Tauri commands for installing / removing marketplace plugin bundles.
//
// install_plugin_bundle is the verified-install path (B Phase 4): download the
// content-addressed bundle from a short-lived Storage signed URL, verify its
// sha256 AND its Ed25519 signature over the canonical message (both against the
// values the publish RPC recorded), then zip-slip-safely unpack into the cache and
// register it as the plugin's active version for the `plugin://` protocol. ANY
// check failing aborts the install and leaves no partial unpack behind.

use tauri::{AppHandle, Manager};

use super::{cache, ActiveVersions};
use plugin_host::{bundle, verify};

/// Hard ceiling mirroring the publish-time 25 MiB cap; a defensive backstop in
/// case a signed URL points at something larger than the recorded byte count.
const MAX_BUNDLE_BYTES: u64 = 26_214_400;

#[tauri::command]
pub async fn install_plugin_bundle(
    app: AppHandle,
    plugin_id: String,
    version: String,
    signed_url: String,
    expected_sha256: String,
    bundle_bytes: u64,
    signature: String,
    sig_alg: String,
    public_key: String,
) -> Result<(), String> {
    // Resolve (and validate) the cache target before any network work.
    let dest = cache::version_dir(&app, &plugin_id, &version)?;
    let plugin_root = cache::plugin_root(&app, &plugin_id)?;

    if sig_alg != "ed25519" {
        return Err(format!("unsupported signature algorithm: {sig_alg}"));
    }
    if bundle_bytes == 0 || bundle_bytes > MAX_BUNDLE_BYTES {
        return Err(format!("bundle_bytes out of range: {bundle_bytes}"));
    }

    // 1. Download.
    let resp = reqwest::get(&signed_url)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download read failed: {e}"))?
        .to_vec();

    // 2. Integrity: byte count + sha256 must match the recorded values.
    if bytes.len() as u64 != bundle_bytes {
        return Err(format!(
            "size mismatch: downloaded {} bytes, expected {bundle_bytes}",
            bytes.len()
        ));
    }
    if !verify::verify_sha256(&bytes, &expected_sha256) {
        return Err("sha256 mismatch (bundle tampered or corrupt)".into());
    }

    // 3. Authenticity: Ed25519 signature over the canonical message.
    let msg = verify::signing_message(&plugin_id, &version, &expected_sha256, bundle_bytes);
    if !verify::verify_signature(&public_key, &signature, &msg) {
        return Err("signature verification failed".into());
    }

    // 4. Unpack into a clean dir. Remove ANY prior version of this plugin so the
    //    active-version map (and the restore-on-launch scan) stays unambiguous.
    if plugin_root.exists() {
        std::fs::remove_dir_all(&plugin_root).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    if let Err(e) = bundle::unpack_zip(&bytes, &dest) {
        let _ = std::fs::remove_dir_all(&plugin_root); // never leave a partial unpack
        return Err(e);
    }

    // 5. Post-unpack sanity: the manifest must be present and its id must match the
    //    plugin we verified (defense against a signed bundle whose contents drifted).
    let manifest_raw = std::fs::read(dest.join("manifest.json"))
        .map_err(|_| "bundle is missing manifest.json".to_string())?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_raw)
        .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;
    if manifest.get("id").and_then(|v| v.as_str()) != Some(plugin_id.as_str()) {
        let _ = std::fs::remove_dir_all(&plugin_root);
        return Err("manifest id does not match the installed plugin id".into());
    }

    // 6. Register as the active version served at plugin://<id>/.
    app.state::<ActiveVersions>().set(plugin_id, version);
    Ok(())
}

#[tauri::command]
pub fn remove_plugin_bundle(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let plugin_root = cache::plugin_root(&app, &plugin_id)?;
    if plugin_root.exists() {
        std::fs::remove_dir_all(&plugin_root).map_err(|e| e.to_string())?;
    }
    app.state::<ActiveVersions>().remove(&plugin_id);
    Ok(())
}
