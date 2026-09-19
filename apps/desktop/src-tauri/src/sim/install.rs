//! Getting the simulator onto a machine that wants it.
//!
//! Helios does not bundle the simulator and never has: it looks for one that
//! is already installed. That is the right default -- somebody who only uses
//! PM and the Vault should not carry a driving simulator around inside their
//! installer -- but it leaves a gap at the other end, because somebody who
//! DOES want it has no way to get it except building it from source.
//!
//! So: an opt-in download. A small JSON manifest names the current build, its
//! size and its SHA-256; Helios fetches the executable, checks the hash, and
//! files it under `%LOCALAPPDATA%\Helios\sim\<version>\`. Nothing becomes an
//! executable until the hash matches.
//!
//! "Until the hash matches" is only true if one install is happening. Two at
//! once used to share one `.part` file and interleave their writes -- and
//! since each hashed the bytes it had READ rather than the file on disk, both
//! passed verification and a spliced binary was renamed into place under a
//! comment promising that could not happen. Hence `INSTALLING` below, and a
//! temp name that belongs to this process.
//!
//! The simulator is ONE self-contained executable -- its frontend, courses and
//! engine data are all embedded at compile time -- so there is no archive to
//! unpack and no install directory to keep consistent. That is worth knowing
//! before anyone reaches for a zip crate.
//!
//! Where the manifest lives is configuration, not code: `HELIOS_SIM_FEED`
//! overrides it, and the default points at the team's Supabase storage bucket.
//! A private bucket works the same way given a URL that carries its own
//! authorisation. A build has to be served from the same origin as the feed
//! that names it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// One shared blocking client for the life of the process.
///
/// In a `OnceLock` so it is never dropped: dropping a `reqwest::blocking::
/// Client` inside an async context panics, and these commands now run on the
/// blocking pool. Same reasoning and same shape as `commands::download`.
static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn client() -> &'static reqwest::blocking::Client {
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            // No redirects: the same-origin check on the build url is worth
            // nothing if the transfer can be bounced elsewhere afterwards.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(600))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// Held for the whole of an install, so two of them cannot share a temp file.
static INSTALLING: Mutex<()> = Mutex::new(());

/// Where to look for builds. A plain HTTPS GET returning `Feed` as JSON.
const DEFAULT_FEED: &str =
    "https://dlmyixonuyckxkknolku.supabase.co/storage/v1/object/public/sim/feed.json";

/// Nothing this large is the simulator; it is 7 MB today. The cap is a guard
/// against a redirect to something enormous, not a real limit.
const MAX_BYTES: u64 = 512 * 1024 * 1024;

fn feed_url() -> String {
    std::env::var("HELIOS_SIM_FEED")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FEED.to_string())
}

/// One downloadable build.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub version: String,
    /// `windows`, `macos` or `linux`.
    pub platform: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub published: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Feed {
    #[serde(default)]
    pub builds: Vec<Build>,
}

/// Do two URLs share a scheme, host and port? Compared textually up to the
/// first `/` after the scheme, which is enough for the fixed shapes this deals
/// with and avoids taking a URL-parsing dependency for one check.
fn same_origin(a: &str, b: &str) -> bool {
    fn origin(u: &str) -> Option<&str> {
        let rest = u.strip_prefix("https://")?;
        Some(&u[..8 + rest.find('/').unwrap_or(rest.len())])
    }
    match (origin(a), origin(b)) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => false,
    }
}

fn this_platform() -> &'static str {
    if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }
}

/// The build on offer for this machine, or nothing.
#[tauri::command]
pub async fn sim_available_build() -> Result<Option<Build>, String> {
    tauri::async_runtime::spawn_blocking(available_build)
        .await
        .map_err(|e| format!("sim_available_build: {e}"))?
}

fn available_build() -> Result<Option<Build>, String> {
    let url = feed_url();
    let res = client()
        .get(&url)
        .timeout(Duration::from_secs(20))
        .send()
        .map_err(|e| format!("could not reach the build feed at {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("build feed returned {} for {url}", res.status()));
    }
    let feed: Feed = res.json().map_err(|e| format!("build feed is not valid JSON: {e}"))?;
    let want = this_platform();
    Ok(feed.builds.into_iter().find(|b| b.platform == want))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub exe_path: String,
    pub bytes: u64,
}

/// Where a downloaded simulator is filed.
///
/// Off `helios_data_dir()`, NOT off the runs directory: `HELIOS_SIM_RUNS_DIR`
/// points the archive at a shared drive, and hanging this off its parent put
/// the installed executable on that share, where every rig overwrote every
/// other rig's copy -- including across platforms.
fn install_root() -> PathBuf {
    super::runs::helios_data_dir().join("sim")
}

/// A version string becomes a directory name, so it has to be one.
fn safe_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && !v.starts_with('.')
}

/// Download, verify, install the build the FEED names. Returns where it landed.
///
/// Takes a version string, not a `Build`. That is the whole security model:
/// an earlier draft accepted the url and the sha256 from the renderer, which
/// made the checksum a transport-integrity check wearing the costume of an
/// authenticity one -- anything executing in the webview could hand over its
/// own url *and* the matching hash, pass verification trivially, and have
/// `sim_set_exe_path` point the launcher at it. The feed is now re-fetched
/// here and only what it names can be installed.
///
/// The hash is checked BEFORE the download becomes an executable: the bytes go
/// to a `.part` file, get hashed, and are renamed into place only if they are
/// what the feed said. A truncated download or a mangled proxy response leaves
/// nothing runnable behind.
#[tauri::command]
pub async fn sim_install(app: tauri::AppHandle, version: String) -> Result<Installed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install(version, &|p| {
            let _ = tauri::Emitter::emit(&app, INSTALL_PROGRESS, p);
        })
    })
    .await
    .map_err(|e| format!("sim_install: {e}"))?
}

/// Progress, for the UI. Emitted from the read loop; see `INSTALL_PROGRESS`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub version: String,
    pub bytes: u64,
    /// What the feed says the whole thing is, or 0 when it did not say.
    pub total: u64,
}

/// The event name both sides agree on.
pub const INSTALL_PROGRESS: &str = "sim://install-progress";

/// A closure rather than an `AppHandle`, and not only for tidiness.
///
/// A `tauri::AppHandle` in a function the unit tests call makes the lib test
/// binary instantiate Tauri's Wry runtime -- which drags in the whole Windows
/// GUI stack (user32, ole32, shell32, uxtheme...), grows the test exe by
/// megabytes and stops it LAUNCHING on Windows with STATUS_ENTRYPOINT_NOT_FOUND,
/// before a single assertion runs. CI is Linux-only, so nobody would have seen
/// it until somebody ran `cargo test` on a rig. Keep the runtime types in the
/// command wrapper; keep the logic testable.
fn install(version: String, progress: &dyn Fn(InstallProgress)) -> Result<Installed, String> {
    // One at a time. Two installs used to share `fsae-sim.exe.part`.
    let _guard = INSTALLING.lock().map_err(|_| "an earlier install left this locked")?;
    let build = available_build()?
        .ok_or("the build feed offers nothing for this platform")?;
    if build.version != version {
        return Err(format!(
            "the feed now offers {} rather than {version}; reopen the tab and try again",
            build.version
        ));
    }
    if !safe_version(&build.version) {
        return Err(format!("not a version: {}", build.version));
    }
    // The build must live where the feed does. A feed that can name an
    // arbitrary host is a feed that can be made to serve anything.
    let feed = feed_url();
    if !same_origin(&build.url, &feed) {
        return Err(format!("that build is not hosted with the feed ({feed})"));
    }
    let expect = build.sha256.trim().to_ascii_lowercase();
    if expect.len() != 64 || !expect.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the feed did not give a SHA-256 for this build".into());
    }

    let dir = install_root().join(&build.version);
    let (dest, total) = fetch_verified(
        &build.url,
        &expect,
        build.bytes,
        &dir,
        &|bytes| progress(InstallProgress {
            version: build.version.clone(),
            bytes,
            total: build.bytes,
        }),
    )?;
    // Point the launcher at it explicitly, so a stale copy elsewhere on the
    // machine cannot win the search afterwards.
    super::launch::sim_set_exe_path(Some(dest.display().to_string()))?;

    Ok(Installed {
        version: build.version,
        exe_path: dest.display().to_string(),
        bytes: total,
    })
}

/// Download one file, verify its SHA-256, and only then let it be an executable.
///
/// Split out from `install` so it can be tested. `install` is where the
/// POLICY lives -- the feed is re-fetched there, the version is matched there,
/// and the build's url is checked to be same-origin with the feed there. This
/// function is the mechanism: given a url and the hash it must have, put it on
/// disk under that name or put nothing there at all. Every early return scrubs
/// the partial file, because a rig that loses its connection twice should not
/// quietly accumulate `.part` files.
///
/// Returns the installed path and the byte count.
fn fetch_verified(
    url: &str,
    expect: &str,
    declared_bytes: u64,
    dir: &std::path::Path,
    progress: &dyn Fn(u64),
) -> Result<(PathBuf, u64), String> {
    let mut res = client()
        .get(url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download returned {}", res.status()));
    }
    if let Some(len) = res.content_length() {
        if len > MAX_BYTES {
            return Err(format!("that build is {len} bytes, which is not a simulator"));
        }
        if declared_bytes > 0 && len != declared_bytes {
            return Err(format!(
                "the feed says {declared_bytes} bytes and the server is sending {len}"
            ));
        }
    }

    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let exe_name = if cfg!(windows) { "fsae-sim.exe" } else { "fsae-sim" };
    // Named for this process as well as guarded by `INSTALLING`: the mutex
    // covers this Helios, the pid covers a second one started by hand.
    let tmp = dir.join(format!("{exe_name}.{}.part", std::process::id()));
    let dest = dir.join(exe_name);

    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let scrub = |e: String| -> String {
        let _ = fs::remove_file(&tmp);
        e
    };
    {
        let mut out = fs::File::create(&tmp)
            .map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = res
                .read(&mut buf)
                .map_err(|e| scrub(format!("download failed: {e}")))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_BYTES {
                let _ = fs::remove_file(&tmp);
                return Err("the download kept going past any plausible size".into());
            }
            hasher.update(&buf[..n]);
            std::io::Write::write_all(&mut out, &buf[..n])
                .map_err(|e| scrub(format!("write {}: {e}", tmp.display())))?;
            // Roughly every 256 KB. A 7 MB file over a conference-centre
            // connection is a long time to look at a button that says
            // "Downloading" and nothing else.
            if total % (256 * 1024) < n as u64 {
                progress(total);
            }
        }
        // The rename below has to publish bytes that are actually on the disk,
        // not bytes that are still in a buffer.
        let _ = out.sync_all();
    }

    // A server that closed early looks exactly like a short file, and the hash
    // would catch it -- but saying which went wrong is worth a line.
    if declared_bytes > 0 && total != declared_bytes {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "the feed says {declared_bytes} bytes and {total} arrived; nothing was installed"
        ));
    }

    let got = format!("{:x}", hasher.finalize());
    if got != expect {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "the download does not match the feed's checksum (expected {expect}, got {got}); nothing was installed"
        ));
    }

    // Only now does it become the executable.
    let _ = fs::remove_file(&dest);
    fs::rename(&tmp, &dest).map_err(|e| format!("install to {}: {e}", dest.display()))?;
    Ok((dest, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// `HELIOS_SIM_FEED` is process-global and Rust runs tests in parallel
    /// threads of one process, so every test that touches it takes this first.
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn a_version_has_to_be_a_directory_name() {
        assert!(safe_version("0.1.0"));
        assert!(safe_version("2026-09-18-a1b2"));
        assert!(!safe_version(".."));
        assert!(!safe_version("../../Windows"));
        assert!(!safe_version("a/b"));
        assert!(!safe_version(""));
        assert!(!safe_version(".hidden"));
    }

    /// A build must be served from the same place as the feed that names it.
    /// Without this, a feed that can be influenced at all can point the
    /// installer anywhere.
    #[test]
    fn a_build_must_share_the_feeds_origin() {
        let feed = "https://x.supabase.co/storage/v1/object/public/sim/feed.json";
        assert!(same_origin("https://x.supabase.co/storage/v1/object/public/sim/w/1/f.exe", feed));
        assert!(same_origin("https://X.SUPABASE.CO/other", feed));
        assert!(!same_origin("https://evil.example/f.exe", feed));
        assert!(!same_origin("https://x.supabase.co.evil.example/f.exe", feed));
        // Plain http is not an origin this accepts at all.
        assert!(!same_origin("http://x.supabase.co/f.exe", feed));
        assert!(!same_origin("https://x.supabase.co:8443/f.exe", feed));
    }

    /// `sim_install` takes a VERSION, not a url and a hash. This is the
    /// property that makes the checksum mean something: the renderer cannot
    /// supply both sides of the comparison. The call below cannot reach a
    /// network (the feed host does not resolve), so it fails at the fetch --
    /// which is itself the proof that it re-fetches rather than trusting an
    /// argument.
    #[test]
    fn install_refetches_the_feed_rather_than_trusting_its_caller() {
        let _guard = lock_env();
        std::env::set_var("HELIOS_SIM_FEED", "https://feed.invalid/feed.json");
        let err = install("0.1.0".into(), &|_| {}).unwrap_err();
        std::env::remove_var("HELIOS_SIM_FEED");
        assert!(
            err.contains("could not reach the build feed"),
            "should have gone to the feed first, got: {err}"
        );
    }

    // ---- the download itself ----
    //
    // `install` is policy (re-fetch the feed, match the version, require the
    // build to be same-origin with it) and `fetch_verified` is mechanism (put
    // these bytes on disk under that name, or put nothing there). The policy
    // half has tests above. This half never had any: the one install test
    // asserts it FAILS at the fetch, so the code that writes an executable to
    // a real disk had never been run by anything but a person.
    //
    // Plain HTTP on loopback, which is why this tests `fetch_verified` rather
    // than `install`: `same_origin` requires https, correctly, and weakening
    // it to make a test easier would be the wrong trade.

    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir()
            .join(format!("helios-sim-install-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    /// Serve `body` once at any path, then stop. Returns its base url.
    ///
    /// `truncate` sends a Content-Length that promises more than it delivers
    /// and then hangs up, which is what a dropped connection looks like.
    fn serve_once(body: Vec<u8>, declared: Option<usize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            let Ok((mut sock, _)) = listener.accept() else { return };
            // Read the request head so the client is not writing into a void.
            {
                use std::io::BufRead;
                let mut r = std::io::BufReader::new(sock.try_clone().expect("clone"));
                let mut line = String::new();
                while r.read_line(&mut line).unwrap_or(0) > 0 {
                    if line == "\r\n" || line == "\n" {
                        break;
                    }
                    line.clear();
                }
            }
            let len = declared.unwrap_or(body.len());
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
            );
            let _ = sock.write_all(head.as_bytes());
            let _ = sock.write_all(&body);
            let _ = sock.flush();
        });
        format!("http://{addr}")
    }

    fn sha_of(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    /// The happy path, on a real disk: bytes in, an executable out.
    #[test]
    fn a_verified_download_becomes_the_executable() {
        let body = b"#!/not-really-an-exe\nbut the bytes are the bytes\n".to_vec();
        let url = serve_once(body.clone(), None);
        let dir = scratch("ok");
        let (dest, total) =
            fetch_verified(&url, &sha_of(&body), body.len() as u64, &dir, &|_| {})
                .expect("install");
        assert_eq!(total, body.len() as u64);
        assert_eq!(fs::read(&dest).expect("read back"), body);
        assert!(dest.file_name().unwrap().to_string_lossy().starts_with("fsae-sim"));
        // And nothing half-written left beside it.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".part"))
            .collect();
        assert!(leftovers.is_empty(), "left a partial file behind: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The whole point of the hash: a build that is not the build the feed
    /// named must leave NOTHING runnable behind.
    #[test]
    fn a_download_that_fails_its_checksum_installs_nothing() {
        let body = b"this is not the simulator".to_vec();
        let url = serve_once(body.clone(), None);
        let dir = scratch("badhash");
        let wrong = sha_of(b"something else entirely");
        let err = fetch_verified(&url, &wrong, body.len() as u64, &dir, &|_| {})
            .expect_err("must refuse");
        assert!(err.contains("checksum"), "unhelpful error: {err}");
        assert!(err.contains("nothing was installed"), "did not say so: {err}");
        // Not merely "the exe is wrong" -- there must be no exe and no part.
        let left: Vec<_> = fs::read_dir(&dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.is_empty(), "something survived a failed verify: {left:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A connection that drops mid-transfer is reported as a short file, not
    /// as a checksum mystery.
    #[test]
    fn a_truncated_download_installs_nothing() {
        let body = b"half a simulator".to_vec();
        // Promise twice what we send, then hang up.
        let url = serve_once(body.clone(), Some(body.len() * 2));
        let dir = scratch("short");
        let err = fetch_verified(&url, &sha_of(&body), (body.len() * 2) as u64, &dir, &|_| {})
            .expect_err("must refuse");
        assert!(
            err.contains("bytes and") || err.contains("download failed"),
            "unhelpful error: {err}"
        );
        let left: Vec<_> = fs::read_dir(&dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.is_empty(), "something survived a truncated download: {left:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A server sending a different length than the feed declared is refused
    /// before a byte is written.
    #[test]
    fn a_length_the_feed_did_not_declare_is_refused() {
        let body = b"a simulator of unexpected size".to_vec();
        let url = serve_once(body.clone(), None);
        let dir = scratch("len");
        let err = fetch_verified(&url, &sha_of(&body), 999_999, &dir, &|_| {})
            .expect_err("must refuse");
        assert!(err.contains("999999"), "did not name the declared size: {err}");
        assert!(!dir.exists(), "made a directory for a download it refused");
    }

    /// Progress is reported, so the button is not a frozen "Downloading...".
    #[test]
    fn progress_is_reported_while_it_downloads() {
        // Over the 256 KB reporting step, so at least one lands.
        let body = vec![7u8; 700 * 1024];
        let url = serve_once(body.clone(), None);
        let dir = scratch("progress");
        let seen = std::sync::Mutex::new(Vec::new());
        let (_, total) = fetch_verified(
            &url,
            &sha_of(&body),
            body.len() as u64,
            &dir,
            &|b| seen.lock().unwrap().push(b),
        )
        .expect("install");
        let seen = seen.into_inner().unwrap();
        assert!(!seen.is_empty(), "no progress at all for a 700 KB download");
        assert!(seen.windows(2).all(|w| w[1] >= w[0]), "progress went backwards: {seen:?}");
        assert!(*seen.last().unwrap() <= total, "progress overran the total");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_feed_url_can_be_pointed_somewhere_else() {
        let _guard = lock_env();
        assert_eq!(feed_url(), DEFAULT_FEED);
        std::env::set_var("HELIOS_SIM_FEED", "https://example.test/feed.json");
        assert_eq!(feed_url(), "https://example.test/feed.json");
        std::env::remove_var("HELIOS_SIM_FEED");
    }
}
