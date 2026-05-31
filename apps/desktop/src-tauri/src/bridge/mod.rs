//! Localhost bridge for the Helios SOLIDWORKS add-in.
//!
//! The add-in is a thin SOLIDWORKS-side client; the real auth/vault logic lives
//! in this desktop app. The bridge exposes a small `127.0.0.1` HTTP API the
//! add-in calls, so check-in/out / get-latest / versions / lock status all run
//! through the one signed-in Helios session instead of duplicating auth in C#.
//!
//! Architecture (see `solidworks-addin/HANDOFF.md`):
//!   - **Metadata ops** (status / versions / checkout) are served natively here
//!     in Rust via Supabase REST, so they answer even while Helios sits
//!     minimized in the tray.
//!   - **Blob ops** (check-in / get-latest) are forwarded to the running UI,
//!     which already has the tested gzip / sha256-verify / atomic-write code —
//!     no risky re-implementation. (Wired in a later commit.)
//!
//! The frontend feeds this module two things over Tauri IPC: the current
//! Supabase session (`bridge_set_session`, refreshed on every auth change) and a
//! snapshot of the vault (`bridge_set_snapshot`) so path↔file_id resolution and
//! lock/version reads don't need to wake the webview.

mod server;
mod supabase;

use std::path::PathBuf;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde::{Deserialize, Serialize};
use tauri::State;

/// The current Supabase session, pushed from the frontend. Holds everything the
/// Rust side needs to make authenticated REST calls as the signed-in user.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub supabase_url: String,
    pub anon_key: String,
    pub access_token: String,
    /// The signed-in user's id (auth.uid). Needed to insert lock rows on
    /// check-out, matching the frontend's `useAcquireLock`.
    pub user_id: String,
}

/// Latest-version facts for a file, enough to answer `/status` without a round
/// trip (the frontend already loaded these).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub version_num: i64,
    pub sha256: String,
    pub revision: Option<i64>,
}

/// Who holds the lock on a file (if anyone), from the frontend's `useLocks`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub user_id: String,
    /// True when the lock belongs to the currently signed-in user.
    pub by_me: bool,
}

/// One vault file as the add-in sees it: its vault id, its resolved local path
/// (so `/status?path=` is a reverse lookup), and its latest/lock state.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub file_id: String,
    /// Absolute local working-copy path, normalized lowercase for matching.
    pub local_path: String,
    pub name: String,
    pub latest: Option<LatestVersion>,
    pub lock: Option<LockInfo>,
}

/// A point-in-time view of the vault the frontend pushes whenever it changes.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The local vault root, or `None` if the user hasn't picked a working
    /// folder yet.
    pub vault_root: Option<String>,
    pub files: Vec<SnapshotFile>,
}

/// Mutable bridge state, guarded for access from the HTTP server thread.
#[derive(Default)]
pub struct Inner {
    pub session: Option<Session>,
    pub snapshot: Snapshot,
}

/// Shared bridge state: an immutable per-launch auth `token` for the loopback
/// API plus the mutable [`Inner`] the frontend keeps current.
pub struct BridgeState {
    /// Per-launch random secret the add-in must present as a bearer token.
    pub token: String,
    /// Reused HTTP client for native Supabase REST calls (metadata ops).
    pub(crate) http: reqwest::Client,
    inner: RwLock<Inner>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            token: random_token(),
            http: reqwest::Client::new(),
            inner: RwLock::new(Inner::default()),
        }
    }

    /// Clone of the current session, if signed in.
    pub(crate) fn session(&self) -> Option<Session> {
        self.read().session.clone()
    }

    /// Resolve a local filesystem path (what the add-in knows) to the vault file
    /// in the current snapshot, if it's tracked. Matching is path-normalized.
    pub(crate) fn file_by_path(&self, path: &str) -> Option<SnapshotFile> {
        let target = norm_path(path);
        self.read()
            .snapshot
            .files
            .iter()
            .find(|f| norm_path(&f.local_path) == target)
            .cloned()
    }

    /// Read access. Recovers from a poisoned lock instead of panicking — the
    /// state is plain data, so a panic in a prior holder is non-fatal (matches
    /// the `PendingOpenFiles` pattern in `lib.rs`).
    pub(crate) fn read(&self) -> RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for BridgeState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the bridge: bind a loopback port, advertise it + the token in the
/// discovery file, and serve the API on a dedicated thread + runtime (kept off
/// Tauri's runtime so it stays responsive regardless of UI/window state).
pub fn start(state: Arc<BridgeState>) -> Result<(), String> {
    // Port 0 => the OS hands us a free port; we read it back and advertise it,
    // so there's never a fixed-port clash with another app.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("bridge: bind 127.0.0.1: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("bridge: local_addr: {e}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("bridge: set_nonblocking: {e}"))?;

    write_discovery_file(port, &state.token)?;

    std::thread::Builder::new()
        .name("helios-bridge".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("bridge: failed to build runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("bridge: from_std: {e}");
                        return;
                    }
                };
                if let Err(e) = axum::serve(listener, server::router(state)).await {
                    eprintln!("bridge: server exited: {e}");
                }
            });
        })
        .map_err(|e| format!("bridge: spawn thread: {e}"))?;

    eprintln!("helios-vault-bridge listening on 127.0.0.1:{port}");
    Ok(())
}

/// Location of the discovery file the add-in reads to find the bridge:
/// `%LOCALAPPDATA%\Helios\bridge.json`.
fn discovery_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Helios")
}

/// Write `{ port, token }` so the add-in can find and authenticate to the
/// bridge. Lives under the user's profile, which is already user-scoped.
fn write_discovery_file(port: u16, token: &str) -> Result<(), String> {
    let dir = discovery_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("bridge: mkdir {}: {e}", dir.display()))?;
    let path = dir.join("bridge.json");
    let body = serde_json::json!({
        "port": port,
        "token": token,
        "api": "helios-vault-bridge/1",
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&body).unwrap())
        .map_err(|e| format!("bridge: write {}: {e}", path.display()))?;
    Ok(())
}

/// Normalize a filesystem path for matching: forward slashes, lowercase, no
/// trailing slash. SOLIDWORKS reports `C:\dir\part.SLDPRT`; the snapshot stores
/// `localDestPath`-style forward-slash paths — normalizing both the same way
/// lets `/status?path=` reverse-resolve regardless of separator/case.
pub(crate) fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// 32 bytes of OS randomness, hex-encoded — the per-launch bridge secret.
fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("bridge: getrandom failed");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Tauri commands — the frontend's push channel into the bridge.
// ---------------------------------------------------------------------------

/// Push (or refresh) the signed-in Supabase session. Called on every auth state
/// change so the Rust side always holds a live access token.
#[tauri::command]
pub fn bridge_set_session(state: State<'_, Arc<BridgeState>>, session: Session) {
    state.write().session = Some(session);
}

/// Clear the session on sign-out, so the bridge stops answering as that user.
#[tauri::command]
pub fn bridge_clear_session(state: State<'_, Arc<BridgeState>>) {
    state.write().session = None;
}

/// Push the current vault snapshot (vault root + per-file path/latest/lock), so
/// metadata endpoints resolve `?path=` and answer without waking the UI.
#[tauri::command]
pub fn bridge_set_snapshot(state: State<'_, Arc<BridgeState>>, snapshot: Snapshot) {
    state.write().snapshot = snapshot;
}
