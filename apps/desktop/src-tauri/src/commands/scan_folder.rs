//! Native local-vault folder scan.
//!
//! The Vault mirrors a subtree of the user's disk against `pdm.files`. Until
//! v5.7.1 the walk lived in the webview (`useLocalFolderScan.ts`): one `stat`
//! IPC round-trip per file every 30 s, and — because the sha256 cache was a
//! `useRef` — a full `readFile` + WebCrypto hash of EVERY file through JS
//! memory on every launch. On an 8,600-file vault that is minutes of main
//! thread time and hundreds of megabytes through the IPC bridge.
//!
//! This module does the same walk natively, with a hash cache persisted under
//! the app's local data dir so a relaunch re-hashes nothing that hasn't
//! changed. The rules below MUST stay byte-for-byte compatible with the JS
//! walk (which remains as the non-Tauri fallback), because `relativePath` is
//! the key every other part of the Vault matches on.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Hard cap on recursion depth, mirroring `MAX_DEPTH` in the JS walk. A vault
/// tree this deep is pathological; the cap is a backstop against cyclic
/// real-path trees behind the symlink skip.
const MAX_DEPTH: usize = 64;

/// Streaming hash buffer. Large enough that a 100 MB CSV is ~100 reads, small
/// enough that a scan never holds a whole file in memory.
const HASH_BUF: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub basename: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub readonly: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root_exists: bool,
    pub entries: Vec<ScanEntry>,
    pub open_in_sw: Vec<String>,
}

/// One persisted hash-cache row. Keyed by absolute path; a hit requires BOTH
/// mtime and size to match (either changing means the content changed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheEntry {
    pub mtime_ms: u64,
    pub size: u64,
    pub sha256: String,
}

pub type ShaCache = HashMap<String, CacheEntry>;

/// Walk `root`, hashing every file that isn't already in `cache` with a
/// matching mtime+size. Pure apart from the filesystem: no `AppHandle`, so it
/// is directly unit-testable.
///
/// Returns the scan result and whether `cache` was mutated (so the caller can
/// skip rewriting an unchanged cache file). Paths no longer present under
/// `root` are dropped from the cache.
pub fn scan_dir(root: &str, cache: &mut ShaCache) -> (ScanResult, bool) {
    let mut entries: Vec<ScanEntry> = Vec::new();
    let mut open_in_sw: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut changed = false;

    // The root's own existence is the one thing the caller MUST be able to
    // distinguish from "empty": an absence-based consumer (auto-sync's
    // locally-deleted detection, the deleted-file reaper) must never infer
    // deletions from a scan of a root that isn't there.
    let root_exists = fs::metadata(root).is_ok();
    if root_exists {
        walk(
            root,
            "",
            &mut entries,
            &mut open_in_sw,
            cache,
            &mut seen,
            &mut changed,
            0,
        );
        // Evict rows for paths that vanished, so a cache file can't grow
        // forever across renames. Only when the root was readable — a missing
        // drive must not wipe the hashes we already know.
        let before = cache.len();
        cache.retain(|path, _| seen.contains(path));
        if cache.len() != before {
            changed = true;
        }
    }

    (
        ScanResult {
            root_exists,
            entries,
            open_in_sw,
        },
        changed,
    )
}

#[allow(clippy::too_many_arguments)]
fn walk(
    dir: &str,
    rel_prefix: &str,
    out: &mut Vec<ScanEntry>,
    open_in_sw: &mut Vec<String>,
    cache: &mut ShaCache,
    seen: &mut HashSet<String>,
    changed: &mut bool,
    depth: usize,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let listing = match fs::read_dir(dir) {
        Ok(l) => l,
        // Unreadable directory (permission denied, vanished mid-walk) — skip
        // it rather than failing the whole scan.
        Err(_) => return,
    };
    for entry in listing.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden + common cruft.
        if name.starts_with('.') {
            continue;
        }
        // SOLIDWORKS writes a `~$<name>` sidecar next to a file while it is
        // open for editing. These are never entries; they are the live
        // "open in SOLIDWORKS" signal, keyed exactly like relative_path below
        // so the FileTable's lookup keys line up.
        if let Some(real) = name.strip_prefix("~$") {
            if !real.is_empty() {
                open_in_sw.push(if rel_prefix.is_empty() {
                    real.to_string()
                } else {
                    format!("{rel_prefix}/{real}")
                });
            }
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Never follow symlinks — a symlinked directory can point back up the
        // tree and turn the walk into an infinite recursion.
        if file_type.is_symlink() {
            continue;
        }
        // Paths are joined with "/" onto the string we were given, exactly as
        // the JS walk built `${dir}/${e.name}`. The rest of the Vault matches
        // on these strings, so the two implementations must agree byte for
        // byte.
        let abs = format!("{dir}/{name}");
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if file_type.is_dir() {
            walk(
                &abs,
                &rel,
                out,
                open_in_sw,
                cache,
                seen,
                changed,
                depth + 1,
            );
        } else if file_type.is_file() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = meta.len();
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let readonly = meta.permissions().readonly();
            let sha = match cache.get(&abs) {
                // A hit needs BOTH mtime and size: either changing means the
                // content changed and we must re-hash.
                Some(hit) if hit.mtime_ms == mtime_ms && hit.size == size => hit.sha256.clone(),
                _ => match hash_file(&abs) {
                    Ok(sha) => {
                        cache.insert(
                            abs.clone(),
                            CacheEntry {
                                mtime_ms,
                                size,
                                sha256: sha.clone(),
                            },
                        );
                        *changed = true;
                        sha
                    }
                    // Unreadable file (locked by another process, permission
                    // denied) — skip it, same as the JS walk.
                    Err(_) => continue,
                },
            };
            seen.insert(abs.clone());
            out.push(ScanEntry {
                basename: name,
                relative_path: rel,
                absolute_path: abs,
                sha256: sha,
                size_bytes: size,
                readonly,
            });
        }
    }
}

/// Streaming sha256 — never holds more than `HASH_BUF` of a file in memory.
fn hash_file(path: &str) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUF];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex_of(&hasher.finalize()))
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Where this root's hash cache lives: one JSON file per root, named by the
/// hex sha256 of the root string so any path (drive letters, UNC shares,
/// spaces) maps to a safe filename.
fn cache_file_for(base_dir: &Path, root: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    base_dir
        .join("scan-cache")
        .join(format!("{}.json", hex_of(&hasher.finalize())))
}

/// A corrupt or missing cache file is simply an empty cache — the scan then
/// re-hashes, which is slow but always correct.
fn load_cache(path: &Path) -> ShaCache {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ShaCache>(&bytes).ok())
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &ShaCache) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(cache)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(path, bytes)
}

#[tauri::command]
pub async fn scan_vault_folder(
    app: tauri::AppHandle,
    root: String,
) -> Result<ScanResult, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let cache_path = cache_file_for(&base, &root);
        let mut cache = load_cache(&cache_path);
        let (result, changed) = scan_dir(&root, &mut cache);
        // Only rewrite when something actually changed: on a warm launch of an
        // unchanged vault this whole command touches no bytes on disk.
        if changed {
            let _ = save_cache(&cache_path, &cache);
        }
        result
    })
    .await
    .map_err(|e| format!("scan_vault_folder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// Unique scratch dir under the OS temp dir (no `tempfile` dependency).
    fn scratch(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "helios-scan-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, body).expect("write file");
    }

    fn find<'a>(res: &'a ScanResult, rel: &str) -> &'a ScanEntry {
        res.entries
            .iter()
            .find(|e| e.relative_path == rel)
            .unwrap_or_else(|| panic!("no entry for {rel} in {:?}", res.entries))
    }

    // sha256("hello") — the known-payload anchor.
    const HELLO_SHA: &str =
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[test]
    fn walks_nested_files_and_hashes_them() {
        let root = scratch("walk");
        write(&root.join("hello.txt"), "hello");
        write(&root.join("Sub").join("inner.txt"), "hello");

        let mut cache = ShaCache::new();
        let (res, changed) = scan_dir(root.to_str().unwrap(), &mut cache);

        assert!(res.root_exists);
        assert!(changed, "a cold scan populates the cache");
        let mut rels: Vec<&str> = res.entries.iter().map(|e| e.relative_path.as_str()).collect();
        rels.sort();
        assert_eq!(rels, vec!["Sub/inner.txt", "hello.txt"]);

        let top = find(&res, "hello.txt");
        assert_eq!(top.basename, "hello.txt");
        assert_eq!(top.sha256, HELLO_SHA);
        assert_eq!(top.size_bytes, 5);
        assert!(!top.readonly);
        // Absolute paths are the root string as given, joined with "/" — the
        // JS walk built `${dir}/${e.name}` and the rest of the Vault matches
        // on those strings.
        assert_eq!(
            find(&res, "Sub/inner.txt").absolute_path,
            format!("{}/Sub/inner.txt", root.to_str().unwrap())
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn skips_hidden_names_and_captures_sw_sidecars() {
        let root = scratch("hidden");
        write(&root.join(".secret"), "x");
        write(&root.join("Part.SLDPRT"), "hello");
        write(&root.join("~$Part.SLDPRT"), "lock");
        write(&root.join("Sub").join("~$Deep.SLDASM"), "lock");
        write(&root.join("Sub").join(".dotfile"), "x");
        // A `~$` name that is nothing but the prefix contributes nothing.
        write(&root.join("~$"), "x");

        let mut cache = ShaCache::new();
        let (res, _) = scan_dir(root.to_str().unwrap(), &mut cache);

        let rels: Vec<&str> = res.entries.iter().map(|e| e.relative_path.as_str()).collect();
        assert_eq!(rels, vec!["Part.SLDPRT"]);
        let mut open = res.open_in_sw.clone();
        open.sort();
        assert_eq!(open, vec!["Part.SLDPRT".to_string(), "Sub/Deep.SLDASM".to_string()]);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_the_read_only_bit() {
        let root = scratch("ro");
        let locked = root.join("locked.txt");
        write(&locked, "hello");
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&locked, perms).unwrap();

        let mut cache = ShaCache::new();
        let (res, _) = scan_dir(root.to_str().unwrap(), &mut cache);
        assert!(find(&res, "locked.txt").readonly);

        // Clear the bit again so the scratch dir can be removed on Windows.
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_readonly(false);
        fs::set_permissions(&locked, perms).ok();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_root_reports_root_exists_false() {
        let root = scratch("missing");
        let gone = root.join("nope");
        let mut cache = ShaCache::new();
        let (res, changed) = scan_dir(gone.to_str().unwrap(), &mut cache);
        assert!(!res.root_exists);
        assert!(res.entries.is_empty());
        assert!(!changed);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_seeded_cache_entry_is_reused_instead_of_rehashing() {
        let root = scratch("cache");
        let file = root.join("hello.txt");
        write(&file, "hello");

        let mut cache = ShaCache::new();
        let (first, _) = scan_dir(root.to_str().unwrap(), &mut cache);
        let abs = first.entries[0].absolute_path.clone();
        assert_eq!(first.entries[0].sha256, HELLO_SHA);

        // Overwrite the cached sha with a sentinel the file could never hash
        // to. A second scan that re-reads the bytes would report HELLO_SHA;
        // reporting the sentinel proves the mtime+size cache hit short-circuits
        // the hash.
        cache.get_mut(&abs).expect("cached by the first scan").sha256 =
            "deadbeef".to_string();
        let (second, changed) = scan_dir(root.to_str().unwrap(), &mut cache);
        assert_eq!(second.entries[0].sha256, "deadbeef");
        assert!(!changed, "an all-hit scan leaves the cache untouched");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_changed_size_invalidates_the_cache_entry() {
        let root = scratch("invalidate");
        let file = root.join("hello.txt");
        write(&file, "hello");
        let mut cache = ShaCache::new();
        let (first, _) = scan_dir(root.to_str().unwrap(), &mut cache);
        let abs = first.entries[0].absolute_path.clone();
        cache.get_mut(&abs).unwrap().sha256 = "deadbeef".to_string();
        cache.get_mut(&abs).unwrap().size = 999;

        let (second, changed) = scan_dir(root.to_str().unwrap(), &mut cache);
        assert_eq!(second.entries[0].sha256, HELLO_SHA);
        assert!(changed);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn vanished_paths_are_dropped_from_the_cache() {
        let root = scratch("evict");
        write(&root.join("a.txt"), "hello");
        write(&root.join("b.txt"), "hello");
        let mut cache = ShaCache::new();
        scan_dir(root.to_str().unwrap(), &mut cache);
        assert_eq!(cache.len(), 2);

        fs::remove_file(root.join("b.txt")).unwrap();
        let (_, changed) = scan_dir(root.to_str().unwrap(), &mut cache);
        assert_eq!(cache.len(), 1);
        assert!(changed, "an eviction is a cache change");

        fs::remove_dir_all(&root).ok();
    }
}
