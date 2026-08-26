// Tauri commands for installing / removing marketplace plugin bundles.
//
// install_plugin_bundle is the verified-install path (B Phase 4): download the
// content-addressed bundle from a short-lived Storage signed URL, verify its
// sha256 AND its Ed25519 signature over the canonical message (both against the
// values the publish RPC recorded), then zip-slip-safely unpack into the cache and
// register it as the plugin's active version for the `plugin://` protocol. ANY
// check failing aborts the install and leaves no partial unpack behind.
//
// STAGE-THEN-SWAP (audit P0-4). Everything — download, unpack, manifest checks,
// permission binding — happens in `cache::staging_dir`, a scratch sibling of the
// install cache. The installed version is only touched at the very end, by
// `cache::swap_into_place`. This matters because the frontend records the install
// SERVER-side first (useMarketplace.ts `install_plugin` RPC): if a failed update
// wiped the on-disk bundle, the server and UI would say "installed vN+1" while
// every launch 404s from `plugin://`. Now a failed update is a true no-op — the
// previous version stays installed and working — and a crash mid-swap is repaired
// at launch by `cache::recover_staging`.

use tauri::{AppHandle, Manager};

use super::{cache, ActiveVersions};
use plugin_host::{bundle, pack, verify};

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
    approved_permissions: Vec<String>,
) -> Result<(), String> {
    // Resolve (and validate) every path before any network work. `dest` is where
    // the new version is UNPACKED (inside staging); `plugin_root` is only written
    // by the final swap.
    let plugin_root = cache::plugin_root(&app, &plugin_id)?;
    let staging = cache::staging_dir(&app, &plugin_id)?;
    let backup = cache::backup_dir(&app, &plugin_id)?;
    if !cache::is_safe_segment(&version) {
        return Err(format!("unsafe plugin version: {version:?}"));
    }
    let dest = staging.join(&version);

    if sig_alg != "ed25519" {
        return Err(format!("unsupported signature algorithm: {sig_alg}"));
    }
    if bundle_bytes == 0 || bundle_bytes > MAX_BUNDLE_BYTES {
        return Err(format!("bundle_bytes out of range: {bundle_bytes}"));
    }

    // 1. Download. Streamed chunk-by-chunk and aborted the moment the ceiling is
    //    crossed, so a signed URL pointing at something enormous can never be fully
    //    buffered in memory first (the old `resp.bytes()` read EVERYTHING, then
    //    checked the limit — enforcing it only after the damage was done).
    let bytes = download_capped(&signed_url, bundle_bytes).await?;

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

    // 4. Unpack + verify entirely in STAGING. Nothing below this point can damage
    //    the currently-installed version: every failure path just drops `staging`.
    //    The checks live in one helper so a SINGLE error site does the cleanup,
    //    instead of every check having to remember to unwind.
    let staged = unpack_and_verify(
        &bytes,
        &staging,
        &dest,
        &plugin_id,
        &approved_permissions,
    );
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging); // never leave a partial unpack
        return Err(e);
    }

    // 5. Swap the verified staging dir into place, retiring the previous version.
    if let Err(e) = cache::swap_into_place(&staging, &plugin_root, &backup) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    // 6. Register as the active version served at plugin://<id>/.
    app.state::<ActiveVersions>().set(plugin_id, version);
    Ok(())
}

/// Download a bundle from a short-lived signed URL, streamed chunk-by-chunk and
/// aborted the moment the ceiling is crossed — a signed URL pointing at something
/// enormous can never be fully buffered in memory first. `expected_bytes` only
/// sizes the initial allocation; the ceiling is what actually bounds the read.
///
/// Shared by the verified-install path and the reviewer's inspect path so the two
/// cannot drift on the one behavior that keeps a hostile URL from exhausting
/// memory.
async fn download_capped(signed_url: &str, expected_bytes: u64) -> Result<Vec<u8>, String> {
    let mut resp = reqwest::get(signed_url)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(expected_bytes.min(MAX_BUNDLE_BYTES) as usize);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("download read failed: {e}"))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_BUNDLE_BYTES {
            return Err(format!(
                "bundle exceeds the {MAX_BUNDLE_BYTES}-byte ceiling; download aborted"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// What `pack_plugin_bundle` hands back to the submit wizard.
///
/// The zip BYTES deliberately do not cross the IPC boundary — a 25 MiB array
/// serialized through JSON would be miserable. The bundle is staged on disk and
/// the frontend reads it back with the fs plugin when it uploads, which also means
/// a failed upload can be retried without re-packing.
#[derive(serde::Serialize)]
pub struct PackedBundleInfo {
    pub staged_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub manifest: serde_json::Value,
    pub entries: Vec<String>,
    pub texts: std::collections::BTreeMap<String, String>,
    pub warnings: Vec<String>,
    pub largest: Vec<(String, u64)>,
}

/// Pack an author's plugin folder into a `.hplugin`, stage it, and return
/// everything the wizard needs to pre-flight and submit it.
///
/// All the rules (what ships, forward-slash entries, determinism, symlink refusal,
/// the size ceiling) live in `plugin_host::pack`, which is unit-tested without a
/// WebView. This is the thin glue: validate the path, call it, stage the bytes.
#[tauri::command]
pub fn pack_plugin_bundle(app: AppHandle, dir: String) -> Result<PackedBundleInfo, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }

    let packed = pack::pack_dir(&root)?;

    let staging = cache::publish_staging_root(&app)?;
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("could not create the staging folder: {e}"))?;
    // Content-addressed, exactly like the Storage key: packing the same folder
    // twice reuses the same staged file instead of accumulating copies.
    let staged_path = staging.join(format!("{}.hplugin", packed.sha256));
    std::fs::write(&staged_path, &packed.zip)
        .map_err(|e| format!("could not stage the packed bundle: {e}"))?;

    let manifest: serde_json::Value = serde_json::from_str(&packed.manifest_json)
        .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;

    Ok(PackedBundleInfo {
        staged_path: staged_path.to_string_lossy().to_string(),
        sha256: packed.sha256,
        bytes: packed.zip.len() as u64,
        manifest,
        entries: packed.entries,
        texts: packed.texts,
        warnings: packed.warnings,
        largest: packed.largest,
    })
}

/// What `inspect_plugin_bundle` hands back to the Review tab.
#[derive(serde::Serialize)]
pub struct InspectedBundle {
    pub manifest: serde_json::Value,
    pub texts: std::collections::BTreeMap<String, String>,
}

/// Read a published bundle's manifest and sources straight out of Storage, so a
/// reviewer can re-run the compliance scan against the bytes that were ACTUALLY
/// uploaded.
///
/// This exists because the report submitted alongside a version is author-supplied
/// and trivially bypassable by calling the publish RPC directly. Nothing is written
/// to disk: previewing a build is a separate, deliberate action.
#[tauri::command]
pub async fn inspect_plugin_bundle(
    signed_url: String,
    expected_sha256: String,
    bundle_bytes: u64,
) -> Result<InspectedBundle, String> {
    let bytes = download_capped(&signed_url, bundle_bytes).await?;

    if bytes.len() as u64 != bundle_bytes {
        return Err(format!(
            "size mismatch: downloaded {} bytes, expected {bundle_bytes}",
            bytes.len()
        ));
    }
    // Scanning bytes that are not the bytes the version recorded would make the
    // whole re-scan meaningless, so this is a hard failure, not a warning.
    if !verify::verify_sha256(&bytes, &expected_sha256) {
        return Err("sha256 mismatch (bundle tampered or corrupt)".into());
    }

    let (manifest_json, texts) = pack::read_zip_texts(&bytes)?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("manifest.json in the bundle is not valid JSON: {e}"))?;

    Ok(InspectedBundle { manifest, texts })
}

/// Delete a staged bundle once its submission has landed. Best-effort.
#[tauri::command]
pub fn discard_staged_bundle(app: AppHandle, sha256: String) -> Result<(), String> {
    // The name is derived here rather than taking a caller-supplied path, so this
    // can only ever delete inside the publish staging area.
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("not a sha256: {sha256:?}"));
    }
    let path = cache::publish_staging_root(&app)?.join(format!("{sha256}.hplugin"));
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// Unpack the (already integrity- and signature-verified) bundle into `dest` and
/// run every post-unpack check against it. Purely staging-local: the caller owns
/// cleanup, and the installed version is not referenced at all.
fn unpack_and_verify(
    bytes: &[u8],
    staging: &std::path::Path,
    dest: &std::path::Path,
    plugin_id: &str,
    approved_permissions: &[String],
) -> Result<(), String> {
    // A leftover staging dir from an interrupted install would otherwise blend its
    // files with the new unpack.
    if staging.exists() {
        std::fs::remove_dir_all(staging).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    bundle::unpack_zip(bytes, dest)?;

    // Post-unpack sanity: the manifest must be present and its id must match the
    // plugin we verified (defense against a signed bundle whose contents drifted).
    let manifest_raw = std::fs::read(dest.join("manifest.json"))
        .map_err(|_| "bundle is missing manifest.json".to_string())?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_raw)
        .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;
    if manifest.get("id").and_then(|v| v.as_str()) != Some(plugin_id) {
        return Err("manifest id does not match the installed plugin id".into());
    }

    // Permission binding (H1). The bundle's manifest.json is signed (via the
    // bundle sha256), but the permissions shown at consent + approved at review
    // come from the SEPARATELY-submitted DB manifest. Enforce that the signed
    // bundle cannot grant itself MORE than was consented/approved: every
    // permission it declares must be in the approved set, else the publisher's
    // bundle drifted from what was reviewed — refuse the install.
    let bundle_perms = manifest
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();
    for p in &bundle_perms {
        if !approved_permissions.iter().any(|a| a.as_str() == *p) {
            return Err(format!(
                "bundle declares permission '{p}' that was not approved for this version"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_plugin_bundle(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let plugin_root = cache::plugin_root(&app, &plugin_id)?;
    // Order matters: the backup/staging dirs go FIRST. `cache::recover_staging`
    // reads "backup present + plugin root missing" as an interrupted swap and
    // restores the backup, so deleting the root first leaves a window where a
    // crash resurrects the add-on the user just uninstalled. Clearing the backup
    // first means the worst case is a leftover root the user can uninstall again.
    if let Ok(staging) = cache::staging_dir(&app, &plugin_id) {
        let _ = std::fs::remove_dir_all(staging);
    }
    if let Ok(backup) = cache::backup_dir(&app, &plugin_id) {
        let _ = std::fs::remove_dir_all(backup);
    }
    if plugin_root.exists() {
        std::fs::remove_dir_all(&plugin_root).map_err(|e| e.to_string())?;
    }
    app.state::<ActiveVersions>().remove(&plugin_id);
    Ok(())
}
