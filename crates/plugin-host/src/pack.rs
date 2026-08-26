//! Turning an author's plugin FOLDER into a `.hplugin` bundle.
//!
//! This is the other half of `bundle::unpack_zip`, and it lives here for the same
//! reason: it is pure (a directory in, bytes out), so every rule below is unit
//! tested without a Tauri runtime.
//!
//! The rule that justifies the whole module: **every zip entry name is built by
//! joining path components with `'/'`**. Publishing has always required that, and
//! it has always been enforced by whoever remembered — a backslash entry produced
//! by `Path::display()` on Windows yields a bundle that unpacks into a single file
//! literally named `dist\index.html`, which then 404s behind `plugin://`. Doing the
//! packing here makes that failure unreachable instead of merely documented.
//!
//! Packing is also DETERMINISTIC: entries are sorted and timestamps zeroed, so the
//! sha256 is a function of content alone. Re-submitting an unchanged folder then
//! produces the same content-addressed key, which is what makes "you already
//! published these exact bytes" a thing the UI can say honestly.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::verify::sha256_hex;

/// Compressed ceiling, matching `marketplace.publish_plugin_version`'s
/// `bundle_bytes` check (25 MiB). Enforced here so the author gets a message
/// naming the offending files instead of a Postgres range exception.
pub const MAX_BUNDLE_BYTES: u64 = 25 * 1024 * 1024;

/// Uncompressed input ceiling — refuse absurd folders before spending time
/// compressing them. Mirrors `bundle::MAX_TOTAL_UNCOMPRESSED`.
const MAX_TOTAL_INPUT: u64 = 200 * 1024 * 1024;

/// Per-file cap on what we will decode as text for the compliance scan.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// Directory names that never belong in a bundle. Matched against ANY path
/// component, so `foo/node_modules/bar` is excluded too.
const EXCLUDED_DIRS: &[&str] = &["node_modules", ".git", "src", ".vscode", ".idea"];

/// File names that never belong in a bundle.
const EXCLUDED_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Extensions the compliance scanner reads. Kept in sync with
/// `SCANNABLE_EXTENSIONS` in `packages/plugin-sdk/src/compliance.mjs`, plus the
/// metadata files the pre-flight reports on.
const TEXT_EXTENSIONS: &[&str] = &["js", "mjs", "html", "css", "json", "md"];

/// The result of packing a folder.
///
/// `Debug` is hand-written: deriving it would dump the whole archive and every
/// source file into any failing assertion, which buries the actual failure.
pub struct PackedBundle {
    /// The `.hplugin` zip bytes.
    pub zip: Vec<u8>,
    /// Lowercase hex sha256 of `zip` — the content-addressed storage key.
    pub sha256: String,
    /// Entry names actually written, sorted, always forward-slashed.
    pub entries: Vec<String>,
    /// Decoded text of every scannable entry, keyed by entry name. Feeds the
    /// pre-flight scan without a second pass over the disk.
    pub texts: BTreeMap<String, String>,
    /// Raw `manifest.json` text.
    pub manifest_json: String,
    /// Non-fatal observations worth showing the author.
    pub warnings: Vec<String>,
    /// The largest entries (name, uncompressed bytes), biggest first, capped at
    /// five. Used to explain a size failure in terms the author can act on.
    pub largest: Vec<(String, u64)>,
}

impl std::fmt::Debug for PackedBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PackedBundle")
            .field("sha256", &self.sha256)
            .field("zip_bytes", &self.zip.len())
            .field("entries", &self.entries)
            .field("scanned", &self.texts.keys().collect::<Vec<_>>())
            .field("warnings", &self.warnings)
            .finish()
    }
}

/// Pack the plugin project rooted at `root` into a `.hplugin` bundle.
///
/// Includes `manifest.json`, everything under the top-level directory named by
/// `manifest.entry` (normally `dist/`), and `manifest.icon` when it lives outside
/// that directory. Everything else is left out — a plugin bundle is the built
/// artifact, not the project.
pub fn pack_dir(root: &Path) -> Result<PackedBundle, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }

    let manifest_path = root.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(
            "no manifest.json in this folder. Pick the folder that contains manifest.json \
             (the plugin's root), not its dist/ folder."
                .into(),
        );
    }
    let manifest_json = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("could not read manifest.json: {e}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;

    let entry = manifest
        .get("entry")
        .and_then(|v| v.as_str())
        .ok_or("manifest.json has no \"entry\" field")?;
    let entry_rel = normalize_rel(entry)
        .ok_or_else(|| format!("manifest.entry is not a safe relative path: {entry}"))?;
    if !root.join(&entry_rel).is_file() {
        return Err(format!(
            "manifest.entry points at {entry}, which is not in this folder — did you run your build?"
        ));
    }

    // The top-level directory of `entry` is what ships. `entry: "index.html"`
    // (no directory) means the root itself is the bundle.
    let entry_root: Option<String> = entry_rel
        .components()
        .next()
        .and_then(|c| match c {
            Component::Normal(os) => os.to_str().map(|s| s.to_string()),
            _ => None,
        })
        .filter(|s| root.join(s).is_dir());

    let mut warnings = Vec::new();
    let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut total_input: u64 = 0;

    // Always the manifest.
    let manifest_len = fs::metadata(&manifest_path).map_err(|e| e.to_string())?.len();
    files.push(("manifest.json".to_string(), manifest_path.clone(), manifest_len));
    total_input += manifest_len;

    match &entry_root {
        Some(dir) => collect(&root.join(dir), root, &mut files, &mut total_input, &mut warnings)?,
        None => collect(root, root, &mut files, &mut total_input, &mut warnings)?,
    }

    // An icon living outside the entry directory still has to ship.
    if let Some(icon) = manifest.get("icon").and_then(|v| v.as_str()) {
        if let Some(icon_rel) = normalize_rel(icon) {
            let name = to_entry_name(&icon_rel);
            let abs = root.join(&icon_rel);
            if abs.is_file() && !files.iter().any(|(n, _, _)| *n == name) {
                let len = fs::metadata(&abs).map_err(|e| e.to_string())?.len();
                total_input += len;
                files.push((name, abs, len));
            } else if !abs.is_file() {
                warnings.push(format!(
                    "manifest.icon points at {icon}, which is not in the folder — the plugin will \
                     show a default icon."
                ));
            }
        }
    }

    if total_input > MAX_TOTAL_INPUT {
        return Err(format!(
            "this folder holds {} of files, far beyond anything a plugin bundle should contain. \
             Check that your build output is not including source data.",
            human_bytes(total_input)
        ));
    }
    if files.len() <= 1 {
        return Err("nothing to pack besides manifest.json — is your build output missing?".into());
    }

    // Deterministic order: content alone decides the sha256.
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.dedup_by(|a, b| a.0 == b.0);

    let mut largest: Vec<(String, u64)> =
        files.iter().map(|(n, _, len)| (n.clone(), *len)).collect();
    largest.sort_by(|a, b| b.1.cmp(&a.1));
    largest.truncate(5);

    let mut texts = BTreeMap::new();
    let mut zip_buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(Cursor::new(&mut zip_buf));
        // Zeroed timestamp: two packs of identical content must hash identically.
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default());

        for (name, abs, _) in &files {
            let mut bytes = Vec::new();
            fs::File::open(abs)
                .map_err(|e| format!("could not read {name}: {e}"))?
                .read_to_end(&mut bytes)
                .map_err(|e| format!("could not read {name}: {e}"))?;

            if is_text_entry(name) && bytes.len() as u64 <= MAX_TEXT_BYTES {
                if let Ok(s) = String::from_utf8(bytes.clone()) {
                    texts.insert(name.clone(), s);
                }
            }

            w.start_file(name.as_str(), opts)
                .map_err(|e| format!("could not add {name} to the bundle: {e}"))?;
            w.write_all(&bytes)
                .map_err(|e| format!("could not write {name} into the bundle: {e}"))?;
        }
        w.finish().map_err(|e| format!("could not finish the bundle: {e}"))?;
    }

    if zip_buf.len() as u64 > MAX_BUNDLE_BYTES {
        let biggest = largest
            .iter()
            .map(|(n, b)| format!("{n} ({})", human_bytes(*b)))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "the packed bundle is {}, over the {} limit. Largest files: {biggest}.",
            human_bytes(zip_buf.len() as u64),
            human_bytes(MAX_BUNDLE_BYTES)
        ));
    }

    let sha256 = sha256_hex(&zip_buf);
    let entries = files.into_iter().map(|(n, _, _)| n).collect();

    Ok(PackedBundle {
        zip: zip_buf,
        sha256,
        entries,
        texts,
        manifest_json,
        warnings,
        largest,
    })
}

/// Read `manifest.json` and every scannable text file out of a packed bundle,
/// without writing anything to disk. This is how a reviewer re-runs the
/// compliance scan against the bytes that were actually uploaded, rather than
/// trusting the report the author submitted alongside them.
pub fn read_zip_texts(bytes: &[u8]) -> Result<(String, BTreeMap<String, String>), String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid zip: {e}"))?;

    let mut manifest_json = String::new();
    let mut texts = BTreeMap::new();
    let mut total: u64 = 0;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        // Not writing to disk, but a nonsense entry name still signals a bundle
        // that was not produced by pack_dir — refuse it rather than scan it.
        if normalize_rel(&name).is_none() {
            return Err(format!("unsafe zip entry path: {name}"));
        }
        if name != "manifest.json" && !is_text_entry(&name) {
            continue;
        }

        let remaining = MAX_TOTAL_INPUT.saturating_sub(total);
        let mut buf = Vec::new();
        entry
            .by_ref()
            .take(remaining.min(MAX_TEXT_BYTES) + 1)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        if buf.len() as u64 > MAX_TEXT_BYTES {
            continue; // too big to be source we care about
        }
        total += buf.len() as u64;

        if let Ok(s) = String::from_utf8(buf) {
            if name == "manifest.json" {
                manifest_json = s;
            } else {
                texts.insert(name, s);
            }
        }
    }

    if manifest_json.is_empty() {
        return Err("the bundle has no manifest.json".into());
    }
    Ok((manifest_json, texts))
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

fn collect(
    dir: &Path,
    root: &Path,
    out: &mut Vec<(String, PathBuf, u64)>,
    total: &mut u64,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let read = fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();

        // Symlinks are refused outright rather than followed: following one can
        // pull arbitrary files from outside the project into a signed bundle.
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{} is a shortcut/symlink. Plugin bundles must contain real files only.",
                rel_display(root, &path)
            ));
        }

        if meta.is_dir() {
            if EXCLUDED_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect(&path, root, out, total, warnings)?;
            continue;
        }

        if EXCLUDED_FILES.contains(&name.as_str()) || name.ends_with(".map") {
            continue;
        }

        let rel = path
            .strip_prefix(root)
            .map_err(|_| format!("{} is outside the plugin folder", path.display()))?;
        let entry_name = to_entry_name(rel);
        if normalize_rel(&entry_name).is_none() {
            return Err(format!("unsafe file path: {entry_name}"));
        }

        *total += meta.len();
        out.push((entry_name, path, meta.len()));
    }
    Ok(())
}

/// Build a zip entry name from a relative path. **This is the forward-slash
/// guarantee** — never `Path::display()`, which yields backslashes on Windows.
fn to_entry_name(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(os) => Some(os.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Normalize a relative path, returning None if it is absolute, escapes the root,
/// or is empty. Accepts both separators, since manifests are authored by hand.
fn normalize_rel(s: &str) -> Option<PathBuf> {
    if s.is_empty() {
        return None;
    }
    let unified = s.replace('\\', "/");
    if unified.starts_with('/') || unified.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in unified.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            p => out.push(p),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_text_entry(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn rel_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(to_entry_name)
        .unwrap_or_else(|_| path.display().to_string())
}

fn human_bytes(n: u64) -> String {
    const MB: u64 = 1024 * 1024;
    const KB: u64 = 1024;
    if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{:.0} KB", n as f64 / KB as f64)
    } else {
        format!("{n} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::unpack_zip;

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// A minimal, valid plugin project.
    fn project(dir: &Path) {
        write(
            dir,
            "manifest.json",
            br#"{"format":1,"id":"aero.test","name":"Test","version":"1.0.0","entry":"dist/index.html","sdk":"^1.0.0","permissions":[]}"#,
        );
        write(dir, "dist/index.html", b"<!doctype html><body>hi</body>");
        write(dir, "dist/app.js", b"console.log(1)");
    }

    #[test]
    fn packs_manifest_and_entry_dir_only() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        // Noise that must NOT ship.
        write(d.path(), "src/app.ts", b"export const x = 1");
        write(d.path(), "node_modules/left-pad/index.js", b"module.exports=1");
        write(d.path(), "dist/app.js.map", b"{}");
        write(d.path(), "dist/.DS_Store", b"junk");
        write(d.path(), "README.md", b"# hi");

        let packed = pack_dir(d.path()).unwrap();

        assert_eq!(
            packed.entries,
            vec!["dist/app.js", "dist/index.html", "manifest.json"]
        );
    }

    #[test]
    fn every_entry_uses_forward_slashes() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        write(d.path(), "dist/assets/deep/style.css", b"body{}");

        let packed = pack_dir(d.path()).unwrap();

        assert!(packed.entries.contains(&"dist/assets/deep/style.css".to_string()));
        for e in &packed.entries {
            assert!(!e.contains('\\'), "entry has a backslash: {e}");
        }
        // And the same must hold when read back out of the archive itself, which
        // is what the install path actually sees.
        let mut zip = zip::ZipArchive::new(Cursor::new(&packed.zip)).unwrap();
        for i in 0..zip.len() {
            let name = zip.by_index(i).unwrap().name().to_string();
            assert!(!name.contains('\\'), "archived entry has a backslash: {name}");
        }
    }

    #[test]
    fn is_deterministic() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());

        let a = pack_dir(d.path()).unwrap();
        let b = pack_dir(d.path()).unwrap();

        assert_eq!(a.sha256, b.sha256);
        assert_eq!(a.zip, b.zip);
    }

    #[test]
    fn refuses_a_folder_without_a_manifest() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "dist/index.html", b"<!doctype html>");

        let err = pack_dir(d.path()).unwrap_err();

        assert!(err.contains("no manifest.json"), "got: {err}");
    }

    #[test]
    fn refuses_when_the_entry_file_is_missing() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "manifest.json",
            br#"{"format":1,"id":"a.b","name":"T","version":"1.0.0","entry":"dist/index.html","sdk":"^1.0.0","permissions":[]}"#,
        );
        write(d.path(), "src/main.ts", b"x");

        let err = pack_dir(d.path()).unwrap_err();

        assert!(err.contains("did you run your build?"), "got: {err}");
    }

    #[test]
    fn refuses_a_traversing_entry_path() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "manifest.json",
            br#"{"format":1,"id":"a.b","name":"T","version":"1.0.0","entry":"../outside/index.html","sdk":"^1.0.0","permissions":[]}"#,
        );

        let err = pack_dir(d.path()).unwrap_err();

        assert!(err.contains("not a safe relative path"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        std::os::unix::fs::symlink("/etc/passwd", d.path().join("dist/secrets.js")).unwrap();

        let err = pack_dir(d.path()).unwrap_err();

        assert!(err.contains("shortcut/symlink"), "got: {err}");
    }

    #[test]
    fn collects_scannable_texts_only() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        write(d.path(), "dist/logo.png", &[0x89, 0x50, 0x4e, 0x47]);

        let packed = pack_dir(d.path()).unwrap();

        assert!(packed.texts.contains_key("dist/app.js"));
        assert!(packed.texts.contains_key("dist/index.html"));
        assert!(packed.texts.contains_key("manifest.json"));
        assert!(!packed.texts.contains_key("dist/logo.png"));
        assert_eq!(packed.texts["dist/app.js"], "console.log(1)");
    }

    #[test]
    fn ships_an_icon_that_lives_outside_the_entry_directory() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "manifest.json",
            br#"{"format":1,"id":"a.b","name":"T","version":"1.0.0","entry":"dist/index.html","icon":"icon.png","sdk":"^1.0.0","permissions":[]}"#,
        );
        write(d.path(), "dist/index.html", b"<!doctype html>");
        write(d.path(), "icon.png", &[0x89, 0x50]);

        let packed = pack_dir(d.path()).unwrap();

        assert!(packed.entries.contains(&"icon.png".to_string()));
    }

    #[test]
    fn warns_when_the_declared_icon_is_absent() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "manifest.json",
            br#"{"format":1,"id":"a.b","name":"T","version":"1.0.0","entry":"dist/index.html","icon":"icon.png","sdk":"^1.0.0","permissions":[]}"#,
        );
        write(d.path(), "dist/index.html", b"<!doctype html>");
        write(d.path(), "dist/app.js", b"1");

        let packed = pack_dir(d.path()).unwrap();

        assert!(
            packed.warnings.iter().any(|w| w.contains("default icon")),
            "got: {:?}",
            packed.warnings
        );
    }

    #[test]
    fn refuses_a_folder_with_nothing_but_a_manifest() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "manifest.json",
            br#"{"format":1,"id":"a.b","name":"T","version":"1.0.0","entry":"index.html","sdk":"^1.0.0","permissions":[]}"#,
        );
        write(d.path(), "index.html", b"<!doctype html>");
        fs::remove_file(d.path().join("index.html")).unwrap();

        let err = pack_dir(d.path()).unwrap_err();

        assert!(err.contains("did you run your build?"), "got: {err}");
    }

    #[test]
    fn round_trips_through_unpack_zip() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        write(d.path(), "dist/assets/deep/style.css", b"body{color:red}");

        let packed = pack_dir(d.path()).unwrap();
        let out = tempfile::tempdir().unwrap();
        unpack_zip(&packed.zip, out.path()).unwrap();

        // The real acceptance criterion: the unpacked tree is a real directory
        // tree, not one file named `dist\index.html`.
        assert!(out.path().join("manifest.json").is_file());
        assert!(out.path().join("dist").join("index.html").is_file());
        assert!(out
            .path()
            .join("dist")
            .join("assets")
            .join("deep")
            .join("style.css")
            .is_file());
        assert_eq!(
            fs::read_to_string(out.path().join("dist/app.js")).unwrap(),
            "console.log(1)"
        );
    }

    #[test]
    fn read_zip_texts_returns_the_manifest_and_the_sources() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        write(d.path(), "dist/logo.png", &[0x89, 0x50, 0x4e, 0x47]);

        let packed = pack_dir(d.path()).unwrap();
        let (manifest, texts) = read_zip_texts(&packed.zip).unwrap();

        assert!(manifest.contains("\"id\":\"aero.test\""));
        assert_eq!(texts["dist/app.js"], "console.log(1)");
        assert!(!texts.contains_key("dist/logo.png"));
        // manifest.json is returned separately, not among the scanned sources.
        assert!(!texts.contains_key("manifest.json"));
    }

    #[test]
    fn read_zip_texts_rejects_a_traversing_entry() {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("manifest.json", opts).unwrap();
            w.write_all(b"{}").unwrap();
            w.start_file("../escape.js", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }

        let err = read_zip_texts(&buf).unwrap_err();

        assert!(err.contains("unsafe zip entry path"), "got: {err}");
    }

    #[test]
    fn reports_the_largest_files_biggest_first() {
        let d = tempfile::tempdir().unwrap();
        project(d.path());
        write(d.path(), "dist/big.js", &vec![b'x'; 5000]);

        let packed = pack_dir(d.path()).unwrap();

        assert_eq!(packed.largest[0].0, "dist/big.js");
        assert_eq!(packed.largest[0].1, 5000);
    }
}
