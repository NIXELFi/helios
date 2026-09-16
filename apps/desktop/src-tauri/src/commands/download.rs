//! Streaming download of one vault object into a temp file.
//!
//! Until v5.7.1 the Vault downloaded through the webview: `storage.download()`
//! produced a Blob, `arrayBuffer()` copied it into JS memory, `gunzipIfNeeded`
//! made a second copy, WebCrypto hashed a third, and `writeFile` pushed the
//! whole thing back across the IPC bridge. A 200-file sync with 8 workers held
//! eight whole files in the renderer at once.
//!
//! Here the transfer, the gzip decode, the hash and the write are one
//! straight-line pass over a 64 KiB buffer inside `spawn_blocking`; nothing
//! larger than that buffer is ever in memory, and no file bytes cross IPC.
//!
//! The command deliberately stops at the temp file and does NOT rename onto
//! the destination: the JS caller owns the rename so its abort guard and
//! read-only handling stay exactly where they were.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub bearer: String,
    pub apikey: String,
    pub dest_path: String,
    pub expected_sha256: String,
    /// Uncompressed size from `pdm.versions.size_bytes`, when the caller
    /// knows it. Only used to scale the per-request stall timeout.
    #[serde(default)]
    pub expected_bytes: Option<u64>,
}

/// reqwest's blocking client ships a 30 s TOTAL request timeout by default.
/// That silently capped every download at whatever 30 s of the user's link
/// could carry (~45 MB on a good day, far less on shop Wi-Fi): a 47 MB ANSYS
/// result hit the limit three times in a row — each retry from byte zero —
/// and the sync looked "hung" on that file for ~95 s before it failed
/// (regression from moving the transfer native in 5.7.1; the webview fetch
/// had no timeout). The client is now unbounded and each request gets a
/// budget scaled to its size so a genuinely stalled connection still ends.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const MIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
/// Floor throughput the budget assumes: 64 KiB/s → a 47 MB file gets ~12 min.
const MIN_BYTES_PER_SEC: u64 = 64 * 1024;

pub fn request_timeout(expected_bytes: Option<u64>) -> Duration {
    let bytes = expected_bytes.unwrap_or(0);
    let scaled = Duration::from_secs(60 + bytes / MIN_BYTES_PER_SEC);
    scaled.max(MIN_REQUEST_TIMEOUT)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub temp_path: String,
    pub bytes: u64,
    pub was_gzip: bool,
}

/// One shared blocking client for the life of the process (connection pool +
/// TLS session reuse across the bulk-download workers). Kept in a `OnceLock`
/// so it is never dropped: dropping a `reqwest::blocking::Client` inside an
/// async context panics.
static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn client() -> &'static reqwest::blocking::Client {
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(None)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// Copy-through writer that hashes the bytes on their way to disk, so the
/// verify costs no extra pass and no buffer.
struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        self.bytes += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

enum FetchError {
    /// Network failure, non-2xx status, or a local write problem — final.
    Transport(String),
    /// The body announced itself as gzip but would not decode. Recoverable:
    /// a legacy object uploaded raw whose first two bytes happen to be the
    /// gzip magic decodes to nothing.
    Decode(String),
}

impl FetchError {
    fn into_message(self) -> String {
        match self {
            FetchError::Transport(m) => m,
            FetchError::Decode(m) => m,
        }
    }
}

/// Read up to `buf.len()` bytes, tolerating short reads. Used to peek the two
/// magic bytes before deciding whether to wrap the stream in a gzip decoder.
fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// One GET, streamed straight into `temp` while hashing. Returns the byte
/// count, the hex sha256 of what was written, and whether the body was gzip.
fn fetch(
    req: &DownloadRequest,
    temp: &Path,
    force_raw: bool,
) -> Result<(u64, String, bool), FetchError> {
    let response = client()
        .get(&req.url)
        .header("Authorization", format!("Bearer {}", req.bearer))
        .header("apikey", req.apikey.as_str())
        .timeout(request_timeout(req.expected_bytes))
        .send()
        .map_err(|e| FetchError::Transport(format!("network error: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        // The status NUMBER must appear in the message: the JS retry loop
        // decides transient-vs-permanent with /504|502|503|timeout|…/.
        let body = response.text().unwrap_or_default();
        let prefix: String = body.chars().take(200).collect();
        return Err(FetchError::Transport(format!(
            "HTTP {}: {}",
            status.as_u16(),
            prefix
        )));
    }

    let mut body = response;
    let mut magic = [0u8; 2];
    let magic_len = read_up_to(&mut body, &mut magic)
        .map_err(|e| FetchError::Transport(format!("read response body: {e}")))?;
    let is_gzip = !force_raw && magic_len == 2 && magic[0] == 0x1f && magic[1] == 0x8b;
    let mut source = std::io::Cursor::new(magic[..magic_len].to_vec()).chain(body);

    let file = fs::File::create(temp)
        .map_err(|e| FetchError::Transport(format!("create {}: {e}", temp.display())))?;
    let mut sink = HashingWriter {
        inner: std::io::BufWriter::new(file),
        hasher: Sha256::new(),
        bytes: 0,
    };

    let copied = if is_gzip {
        std::io::copy(&mut MultiGzDecoder::new(&mut source), &mut sink)
    } else {
        std::io::copy(&mut source, &mut sink)
    };
    if let Err(e) = copied {
        return Err(if is_gzip {
            FetchError::Decode(format!("gzip decode failed: {e}"))
        } else {
            FetchError::Transport(format!("read response body: {e}"))
        });
    }
    sink.flush()
        .map_err(|e| FetchError::Transport(format!("write {}: {e}", temp.display())))?;

    Ok((sink.bytes, hex_of(&sink.hasher.finalize()), is_gzip))
}

/// Download `req.url` into `<dest_path>.<uuid>.part`, verifying the sha256.
/// The temp file is left in place for the caller to rename; on any failure it
/// is removed so orphaned `.part` files can't accumulate (the local scan
/// would otherwise surface them as vault candidates).
pub fn download_to_temp(req: &DownloadRequest) -> Result<DownloadResult, String> {
    let expected = req.expected_sha256.to_lowercase();
    let temp = format!("{}.{}.part", req.dest_path, uuid::Uuid::new_v4());
    let temp_path = Path::new(&temp);
    if let Some(parent) = temp_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
    }

    let mismatch = |sha: &str| format!("sha256 mismatch: expected {expected}, got {sha}");

    match fetch(req, temp_path, false) {
        Ok((bytes, sha, was_gzip)) => {
            if sha == expected {
                return Ok(DownloadResult {
                    temp_path: temp,
                    bytes,
                    was_gzip,
                });
            }
            let _ = fs::remove_file(temp_path);
            if !was_gzip {
                return Err(mismatch(&sha));
            }
            // Fall through: gunzip produced the wrong bytes, so the object is
            // probably a raw file that merely starts with the gzip magic.
        }
        Err(FetchError::Transport(message)) => {
            let _ = fs::remove_file(temp_path);
            return Err(message);
        }
        Err(FetchError::Decode(_)) => {
            let _ = fs::remove_file(temp_path);
        }
    }

    // Second and final attempt: treat the body as raw bytes.
    let (bytes, sha, _) = fetch(req, temp_path, true).map_err(|e| {
        let _ = fs::remove_file(temp_path);
        e.into_message()
    })?;
    if sha == expected {
        Ok(DownloadResult {
            temp_path: temp,
            bytes,
            was_gzip: false,
        })
    } else {
        let _ = fs::remove_file(temp_path);
        Err(mismatch(&sha))
    }
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[tauri::command]
pub async fn download_object_to_temp(req: DownloadRequest) -> Result<DownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || download_to_temp(&req))
        .await
        .map_err(|e| format!("download_object_to_temp: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    // sha256("hello")
    const HELLO_SHA: &str =
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn scratch_dest(tag: &str) -> String {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "helios-dl-{tag}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir.join("out.bin").to_string_lossy().replace('\\', "/")
    }

    fn http(status: u16, reason: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// One-shot HTTP server that replies with `responses` in order, one per
    /// connection, and hands back the raw request head of each.
    fn serve(responses: Vec<Vec<u8>>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let handle = thread::spawn(move || {
            let mut seen = Vec::new();
            for response in responses {
                let (sock, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = std::io::BufReader::new(sock);
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let done = line == "\r\n" || line == "\n";
                            head.push_str(&line);
                            if done {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                seen.push(head);
                let mut sock = reader.into_inner();
                let _ = sock.write_all(&response);
                let _ = sock.flush();
            }
            seen
        });
        (format!("http://{addr}/obj"), handle)
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(bytes).expect("gzip write");
        enc.finish().expect("gzip finish")
    }

    fn request(url: String, dest: String, expected: &str) -> DownloadRequest {
        DownloadRequest {
            url,
            bearer: "tok123".to_string(),
            apikey: "anon456".to_string(),
            dest_path: dest,
            expected_sha256: expected.to_string(),
            expected_bytes: None,
        }
    }

    #[test]
    fn request_timeout_scales_with_size_and_never_drops_below_the_floor() {
        assert_eq!(request_timeout(None), MIN_REQUEST_TIMEOUT);
        assert_eq!(request_timeout(Some(1_097)), MIN_REQUEST_TIMEOUT);
        // 47 MB ANSYS result: 60 s + 47_054_848 / 65_536 s ≈ 778 s.
        assert_eq!(request_timeout(Some(47_054_848)), Duration::from_secs(60 + 718));
    }

    #[test]
    fn writes_a_raw_body_to_a_temp_file_and_verifies_its_hash() {
        let (url, server) = serve(vec![http(200, "OK", b"hello")]);
        let dest = scratch_dest("raw");
        let out = download_to_temp(&request(url, dest.clone(), HELLO_SHA)).expect("download");

        assert!(!out.was_gzip);
        assert_eq!(out.bytes, 5);
        assert!(out.temp_path.ends_with(".part"), "got {}", out.temp_path);
        assert_eq!(fs::read(&out.temp_path).expect("read temp"), b"hello");
        // The real destination is never written — the JS side owns the rename.
        assert!(!Path::new(&dest).exists());

        let heads = server.join().expect("server");
        let head = heads[0].to_lowercase();
        assert!(head.contains("authorization: bearer tok123"), "{head}");
        assert!(head.contains("apikey: anon456"), "{head}");

        fs::remove_file(&out.temp_path).ok();
    }

    #[test]
    fn decompresses_a_gzip_body() {
        let (url, server) = serve(vec![http(200, "OK", &gzip(b"hello"))]);
        let dest = scratch_dest("gzip");
        let out = download_to_temp(&request(url, dest, HELLO_SHA)).expect("download");

        assert!(out.was_gzip);
        assert_eq!(out.bytes, 5);
        assert_eq!(fs::read(&out.temp_path).expect("read temp"), b"hello");
        server.join().ok();
        fs::remove_file(&out.temp_path).ok();
    }

    #[test]
    fn a_gateway_error_surfaces_the_status_code_for_the_js_retry_regex() {
        let (url, server) = serve(vec![http(504, "Gateway Timeout", b"upstream gone")]);
        let dest = scratch_dest("504");
        let err = download_to_temp(&request(url, dest, HELLO_SHA)).expect_err("should fail");
        assert!(err.contains("504"), "{err}");
        server.join().ok();
    }

    #[test]
    fn a_raw_body_that_merely_starts_with_the_gzip_magic_is_recovered() {
        // The legacy case: an object uploaded before the gzip era whose first
        // two bytes happen to be 1f 8b. The decode fails (or produces the
        // wrong bytes), so the transfer is retried once as raw.
        let payload: Vec<u8> = vec![0x1f, 0x8b, 0x00, 0x11, 0x22, 0x33];
        let expected = {
            let mut h = Sha256::new();
            h.update(&payload);
            format!("{:x}", h.finalize())
        };
        let (url, server) = serve(vec![
            http(200, "OK", &payload),
            http(200, "OK", &payload),
        ]);
        let dest = scratch_dest("magic");
        let out = download_to_temp(&request(url, dest, &expected)).expect("download");

        assert!(!out.was_gzip, "the recovered payload is raw");
        assert_eq!(fs::read(&out.temp_path).expect("read temp"), payload);
        server.join().ok();
        fs::remove_file(&out.temp_path).ok();
    }

    #[test]
    fn a_hash_mismatch_errors_and_leaves_no_temp_file_behind() {
        let (url, server) = serve(vec![http(200, "OK", b"hello")]);
        let dest = scratch_dest("mismatch");
        let wrong = "0".repeat(64);
        let err = download_to_temp(&request(url, dest.clone(), &wrong)).expect_err("should fail");
        assert!(err.contains("sha256 mismatch"), "{err}");
        assert!(err.contains(HELLO_SHA), "the actual hash is reported: {err}");

        let parent = Path::new(&dest).parent().expect("parent").to_path_buf();
        let leftovers: Vec<_> = fs::read_dir(&parent)
            .expect("read dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
        server.join().ok();
    }
}
