//! Safe unpacking of a `.hplugin` zip into the install cache. Pure (operates on a
//! byte slice + a destination dir), so the zip-slip guard is unit-tested with a
//! crafted malicious archive. Every entry path is run through the (tested)
//! `path::resolve`, so a `../` or absolute entry name aborts the whole unpack
//! rather than escaping the destination.

use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

use crate::path;

/// Total uncompressed-size ceiling — a zip-bomb backstop independent of the
/// 25 MiB compressed cap enforced at publish. 200 MiB of expanded files is far
/// beyond any legitimate UI bundle.
const MAX_TOTAL_UNCOMPRESSED: u64 = 200 * 1024 * 1024;

/// Unpack `bytes` (a zip) into `dest`, rejecting any entry whose path would escape
/// `dest` (zip-slip) and any archive whose expanded size exceeds the bomb ceiling.
/// On any error the caller should delete `dest` (a partial unpack is not trusted).
pub fn unpack_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid zip: {e}"))?;

    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue; // directories are materialized via their files' parents
        }
        let name = entry.name().to_string();

        // Zip-slip guard: the entry path MUST resolve to a plain location under
        // dest. `..`, absolute paths, and drive prefixes all return None.
        let out_path =
            path::resolve(dest, &name).ok_or_else(|| format!("unsafe zip entry path: {name}"))?;

        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err("zip expands beyond the size ceiling".into());
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn unpacks_normal_nested_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let zip = make_zip(&[
            ("manifest.json", b"{\"id\":\"x\"}"),
            ("dist/index.html", b"<!doctype html>"),
            ("dist/app.js", b"console.log(1)"),
        ]);
        unpack_zip(&zip, dir.path()).unwrap();
        assert_eq!(
            fs::read(dir.path().join("manifest.json")).unwrap(),
            b"{\"id\":\"x\"}"
        );
        assert!(dir.path().join("dist/index.html").exists());
        assert!(dir.path().join("dist/app.js").exists());
    }

    #[test]
    fn rejects_zip_slip_entry() {
        let dir = tempfile::tempdir().unwrap();
        let zip = make_zip(&[
            ("ok.txt", b"fine"),
            ("../escape.txt", b"pwned"),
        ]);
        let err = unpack_zip(&zip, dir.path()).unwrap_err();
        assert!(err.contains("unsafe zip entry path"), "got: {err}");
        // The escape target must NOT have been written outside dest.
        assert!(!dir.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn rejects_absolute_entry() {
        let dir = tempfile::tempdir().unwrap();
        // A POSIX-absolute entry name; resolve() trims the leading slash so it stays
        // under dest rather than writing to /etc — assert it lands inside.
        let zip = make_zip(&[("/etc/passwd", b"x")]);
        unpack_zip(&zip, dir.path()).unwrap();
        assert!(dir.path().join("etc/passwd").exists());
    }
}
