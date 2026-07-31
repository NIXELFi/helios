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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

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
    /// Display name + email, surfaced by the add-in so it's obvious who's
    /// connected. Optional — older frontends may not send them.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
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
    /// Absolute local working-copy path (any separator; matched normalized).
    pub local_path: String,
    pub name: String,
    /// Which vault this file belongs to (Helios is multi-vault — a file open in
    /// SOLIDWORKS could be from any vault the user has).
    #[serde(default)]
    pub vault_name: Option<String>,
    /// The file's latest-version id. The snapshot stays lean (no per-version
    /// rows); `/status` resolves version/sha from this on demand.
    #[serde(default)]
    pub latest_version_id: Option<String>,
    #[serde(default)]
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

/// An optimistic, bridge-originated change to a file that the frontend's pushed
/// snapshot hasn't caught up to yet. Held per file_id so a concurrent
/// `bridge_set_snapshot` (the UI's periodic full-snapshot push) can't revert a
/// lock/version the bridge applied a moment ago via a `/checkout` or `/checkin`.
/// Each override is dropped once an incoming snapshot already reflects it.
#[derive(Clone, Debug, Default)]
pub struct OptimisticOverride {
    /// `Some(lock)` = locked-by-me applied; `Some(None)` inner = explicitly
    /// cleared (check-in). `None` = no optimistic lock change pending.
    pub lock: Option<Option<LockInfo>>,
    /// Optimistic latest-version pointer set on check-in, pending UI confirmation.
    pub latest_version_id: Option<String>,
    /// Wall-clock millis (`now_ms`) when this override was applied. Overrides
    /// EXPIRE: they exist only to cover the sub-second window between a bridge
    /// op and the UI's next snapshot push. Without a TTL a `/checkin` override
    /// (`lock: Some(None)`) that a coworker's immediate check-out contradicts is
    /// never confirmed, so every later push gets the stale value re-applied and
    /// `/status`, `/status-batch`, `/files` and the Explorer overlay all report
    /// the file available until the app restarts (mirror case: an admin
    /// force-unlock stays invisible after `mark_locked_by_me`).
    pub applied_ms: u64,
}

/// Mutable bridge state, guarded for access from the HTTP server thread.
#[derive(Default)]
pub struct Inner {
    pub session: Option<Session>,
    pub snapshot: Snapshot,
    /// Per-file optimistic overrides not yet confirmed by a frontend snapshot
    /// push. Keyed by file_id. Empty in steady state.
    pub optimistic: HashMap<String, OptimisticOverride>,
}

/// How long after the last authenticated add-in request we still consider the
/// add-in "connected". The add-in polls /health well within this window; once it
/// stops (SOLIDWORKS closed, add-in disabled), activity goes stale and the
/// frontend stops the expensive vault-structure refresh — the snapshot is only
/// consumed by the add-in, so nothing observes the staleness while it's gone.
const ADDIN_IDLE_MS: u64 = 90_000;

/// How long an unconfirmed optimistic override keeps overriding pushed snapshots.
/// The UI pushes a fresh snapshot within a second or two of any bridge op, so a
/// few seconds is generous cover for the race; past that, an override that still
/// disagrees is far more likely to be STALE (a coworker grabbed the lock, an
/// admin force-unlocked) than early, and continuing to re-apply it hides the
/// real state indefinitely. Ceiling, not a schedule — a confirmed override is
/// dropped immediately, well before this.
const OPTIMISTIC_TTL_MS: u64 = 5_000;

/// Wall-clock millis since the Unix epoch (matches JS `Date.now()`).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Is the add-in currently connected, given the last-seen request time? `last==0`
/// means "no request ever seen" → not active.
fn is_active(last_ms: u64, now: u64, idle_ms: u64) -> bool {
    last_ms != 0 && now.saturating_sub(last_ms) < idle_ms
}

/// Does a request at `now` represent a fresh connection (vs. an already-active
/// add-in)? True on the very first request and whenever the add-in had gone
/// idle — the caller fires an immediate snapshot refresh on these.
fn reconnected(prev_ms: u64, now: u64, idle_ms: u64) -> bool {
    prev_ms == 0 || now.saturating_sub(prev_ms) >= idle_ms
}

/// Shared bridge state: an immutable per-launch auth `token` for the loopback
/// API plus the mutable [`Inner`] the frontend keeps current.
pub struct BridgeState {
    /// Per-launch random secret the add-in must present as a bearer token.
    pub token: String,
    /// Reused HTTP client for native Supabase REST calls (metadata ops).
    pub(crate) http: reqwest::Client,
    /// App handle, set at startup, used to emit blob-op events to the UI.
    app: OnceLock<AppHandle>,
    /// In-flight forwarded blob ops, keyed by request id → reply channel.
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    /// Wall-clock millis of the last authenticated add-in request, or 0 if none
    /// yet. Updated by the request guard; read by the frontend (via
    /// `bridge_addin_active`) to gate the expensive vault-structure refresh.
    last_activity: AtomicU64,
    inner: RwLock<Inner>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            token: random_token(),
            http: reqwest::Client::new(),
            app: OnceLock::new(),
            pending: Mutex::new(HashMap::new()),
            last_activity: AtomicU64::new(0),
            inner: RwLock::new(Inner::default()),
        }
    }

    /// Record an authenticated add-in request and report whether it's a fresh
    /// connection (first ever, or after the add-in had gone idle). The request
    /// guard calls this on every authed request and, on a reconnect, emits
    /// `bridge://addin-connected` so the frontend pushes a snapshot immediately.
    pub(crate) fn touch_activity(&self) -> bool {
        let now = now_ms();
        let prev = self.last_activity.swap(now, Ordering::Relaxed);
        reconnected(prev, now, ADDIN_IDLE_MS)
    }

    /// Is the add-in currently connected (an authed request within the idle
    /// window)? The frontend polls this to decide whether the periodic
    /// vault-structure refresh is worth doing.
    pub(crate) fn addin_active(&self) -> bool {
        is_active(self.last_activity.load(Ordering::Relaxed), now_ms(), ADDIN_IDLE_MS)
    }

    /// Clone of the current session, if signed in.
    pub(crate) fn session(&self) -> Option<Session> {
        self.read().session.clone()
    }

    /// Optimistically mark a file as checked-out-by-me in the snapshot, so a
    /// `/status` right after a `/checkout` reflects the new lock immediately —
    /// the frontend only re-pushes lock state on its poll interval, and a
    /// bridge-initiated check-out doesn't fire the in-app lock bus.
    pub(crate) fn mark_locked_by_me(&self, file_id: &str) {
        let Some(session) = self.session() else { return };
        let lock = LockInfo { user_id: session.user_id, by_me: true };
        let mut inner = self.write();
        // Record the override FIRST so a concurrent snapshot push that lands
        // between the two writes still re-applies it on merge.
        let ov = inner.optimistic.entry(file_id.to_string()).or_default();
        ov.lock = Some(Some(lock.clone()));
        ov.applied_ms = now_ms(); // (re)start the TTL — see OPTIMISTIC_TTL_MS
        if let Some(f) = inner.snapshot.files.iter_mut().find(|f| f.file_id == file_id) {
            f.lock = Some(lock);
        }
    }

    /// Optimistically clear a file's lock (check-in releases it).
    pub(crate) fn clear_lock(&self, file_id: &str) {
        let mut inner = self.write();
        let ov = inner.optimistic.entry(file_id.to_string()).or_default();
        ov.lock = Some(None);
        ov.applied_ms = now_ms();
        if let Some(f) = inner.snapshot.files.iter_mut().find(|f| f.file_id == file_id) {
            f.lock = None;
        }
    }

    /// Optimistically point a file at its new latest version (after a check-in),
    /// so `/status` reports the fresh version before the frontend's next push.
    pub(crate) fn set_latest_version_id(&self, file_id: &str, version_id: &str) {
        let mut inner = self.write();
        let ov = inner.optimistic.entry(file_id.to_string()).or_default();
        ov.latest_version_id = Some(version_id.to_string());
        ov.applied_ms = now_ms();
        if let Some(f) = inner.snapshot.files.iter_mut().find(|f| f.file_id == file_id) {
            f.latest_version_id = Some(version_id.to_string());
        }
    }

    /// Replace the snapshot with the frontend's freshly-pushed one, but re-apply
    /// any still-pending optimistic overrides so a concurrent UI push can't revert
    /// a lock/version the bridge applied a moment ago (after a `/checkout` or
    /// `/checkin`). An override is dropped once the incoming snapshot already
    /// reflects it — that's the UI confirming the change, making the override
    /// redundant and letting genuine later remote changes through.
    pub(crate) fn apply_snapshot(&self, snapshot: Snapshot) {
        let mut inner = self.write();
        let Inner { snapshot: cur, optimistic, .. } = &mut *inner;
        *cur = merge_snapshot(snapshot, optimistic, now_ms());
    }

    /// Write the path→state cache the Windows Explorer shell extensions read for
    /// overlay icons / status columns / context-menu enablement. Keyed by
    /// normalized path (forward slashes + lowercase) so the C# side can look up
    /// with the same normalization. Best-effort + cheap (it runs on every
    /// snapshot/lock change); failures are logged, never fatal.
    ///
    /// Takes a read lock, so callers MUST NOT hold the write lock when calling
    /// it (that would deadlock the RwLock) — call it after the mutating method
    /// returns.
    pub(crate) fn write_shell_state(&self) {
        self.write_shell_state_to(&discovery_dir());
    }

    /// Inner of [`write_shell_state`] taking an explicit dir, so tests don't have
    /// to mutate the process-global `LOCALAPPDATA`.
    fn write_shell_state_to(&self, dir: &std::path::Path) {
        // Build the JSON under the read lock, then drop the lock before touching
        // the filesystem. The build itself lives in the free `build_shell_state`
        // so it can be unit-tested without constructing a `BridgeState` (which
        // would link the bridge's reqwest/HTTP stack into the test binary).
        let body = {
            let inner = self.read();
            build_shell_state(&inner.snapshot)
        };
        let path = dir.join("shell-state.json");
        let _ = std::fs::create_dir_all(dir);
        match serde_json::to_vec(&body) {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&path, bytes) {
                    eprintln!("bridge: write shell-state failed: {e}");
                }
            }
            Err(e) => eprintln!("bridge: serialize shell-state failed: {e}"),
        }
    }

    /// Register a forwarded blob op and return its id + reply receiver.
    pub(crate) fn register_pending(&self) -> (String, oneshot::Receiver<Value>) {
        let id = random_id();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);
        (id, rx)
    }

    /// Deliver a UI reply to whichever blob op is waiting on `id`.
    pub(crate) fn resolve_pending(&self, id: &str, value: Value) {
        if let Some(tx) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            let _ = tx.send(value);
        }
    }

    /// Drop a pending op (e.g. on timeout) so the map doesn't leak.
    pub(crate) fn drop_pending(&self, id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    /// The app handle, once startup has set it (used to resolve bundled
    /// resources like the SW read-only helper).
    pub(crate) fn app_handle(&self) -> Option<&AppHandle> {
        self.app.get()
    }

    /// Emit an event to the UI (used to forward blob ops). Errors if the app
    /// handle isn't set yet (shouldn't happen post-setup).
    pub(crate) fn emit(&self, event: &str, payload: &Value) -> Result<(), String> {
        let app = self.app.get().ok_or("bridge: app handle not ready")?;
        app.emit(event, payload).map_err(|e| e.to_string())
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
pub fn start(app: AppHandle, state: Arc<BridgeState>) -> Result<(), String> {
    let _ = state.app.set(app);
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
///
/// ASCII-only case folding is deliberate. Windows (and .NET, which the add-in
/// and shell extensions are written in) compares paths with ORDINAL
/// case-insensitivity; Rust's Unicode `to_lowercase` folds more aggressively —
/// U+212A KELVIN SIGN becomes `k`, U+0130 becomes `i̇` — so two paths NTFS
/// considers distinct would collide here. `file_by_path` returns the FIRST
/// match, so a collision silently resolves `/checkout` and `/checkin` to the
/// wrong file_id. `to_ascii_lowercase` matches what the OS and the C# side do.
pub(crate) fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

/// Merge a freshly-pushed snapshot with the still-pending optimistic overrides,
/// re-applying any the incoming snapshot hasn't caught up to and dropping (from
/// `optimistic`) any it has confirmed. Pure (no `self`, no I/O) so it can be
/// unit-tested without constructing a `BridgeState` (which links the bridge's
/// reqwest/HTTP stack into the test binary — see `build_shell_state`). Returns
/// the merged snapshot to store.
/// An override is dropped on EITHER condition:
///   1. **Confirmed** — the incoming snapshot already carries the value we
///      optimistically applied. That's the UI agreeing with us, so the override
///      is redundant; keeping it would make a genuine LATER remote change (a
///      coworker's check-out) get overridden back.
///   2. **Expired** — `OPTIMISTIC_TTL_MS` has passed since it was applied. An
///      override the UI never confirms is not "still racing", it's wrong: the
///      classic case is `/checkin` recording `lock: Some(None)` and a coworker
///      checking the file out a moment later, after which every push disagrees
///      forever and the whole app reports the file available until restart.
/// Confirmation is tracked per FIELD (lock and version expire independently),
/// so a confirmed lock can't be resurrected by a still-pending version pointer.
fn merge_snapshot(
    mut snapshot: Snapshot,
    optimistic: &mut HashMap<String, OptimisticOverride>,
    now: u64,
) -> Snapshot {
    optimistic.retain(|file_id, ov| {
        let Some(f) = snapshot.files.iter_mut().find(|f| &f.file_id == file_id) else {
            // File no longer in the snapshot — nothing to protect; drop it.
            return false;
        };
        // saturating_sub so a backwards clock step can't make an old override
        // look freshly applied and pin it in place.
        if now.saturating_sub(ov.applied_ms) >= OPTIMISTIC_TTL_MS {
            // Expired: let the pushed snapshot through untouched. Whatever the
            // server says is now more trustworthy than our stale guess.
            return false;
        }
        let mut still_pending = false;

        if let Some(want_lock) = &ov.lock {
            if lock_matches(&f.lock, want_lock) {
                // UI has caught up to our optimistic lock state — confirmed.
                ov.lock = None;
            } else {
                f.lock = want_lock.clone();
                still_pending = true;
            }
        }

        if let Some(want_ver) = &ov.latest_version_id {
            if f.latest_version_id.as_deref() == Some(want_ver.as_str()) {
                // Confirmed by the UI; stop overriding.
                ov.latest_version_id = None;
            } else {
                f.latest_version_id = Some(want_ver.clone());
                still_pending = true;
            }
        }

        still_pending
    });
    snapshot
}

/// Whether two optional lock states are equivalent for the purpose of confirming
/// an optimistic override: both unlocked, or both held by the same user with the
/// same by-me flag.
fn lock_matches(a: &Option<LockInfo>, b: &Option<LockInfo>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.user_id == y.user_id && x.by_me == y.by_me,
        _ => false,
    }
}

/// Map a file's lock state to the compact state string the shell extensions key
/// their overlay icons / status text off of.
pub(crate) fn shell_state_for(f: &SnapshotFile) -> &'static str {
    match &f.lock {
        Some(l) if l.by_me => "out-me",
        Some(_) => "out-other",
        None => "available",
    }
}

/// Build the shell-state document (vault root + per-file overlay/status state),
/// keyed by normalized path (forward slashes + lowercase) so the C# shell side
/// looks up with the same normalization. Pure (no `self`, no I/O) so it can be
/// unit-tested without constructing a `BridgeState` — constructing one pulls the
/// bridge's reqwest/HTTP stack into the test binary, which on Windows then fails
/// to launch as a bare test executable (`STATUS_ENTRYPOINT_NOT_FOUND`).
pub(crate) fn build_shell_state(snapshot: &Snapshot) -> Value {
    let mut states = serde_json::Map::with_capacity(snapshot.files.len());
    for f in &snapshot.files {
        states.insert(
            norm_path(&f.local_path),
            serde_json::json!({
                "state": shell_state_for(f),
                "name": f.name,
                "fileId": f.file_id,
                "vault": f.vault_name,
                // Holder's auth uid when checked out by someone else (the
                // snapshot doesn't carry display names — the context menu
                // resolves the friendly name on demand via /status).
                "by": f.lock.as_ref().filter(|l| !l.by_me).map(|l| l.user_id.clone()),
            }),
        );
    }
    serde_json::json!({
        "vaultRoot": snapshot.vault_root,
        "files": states,
    })
}

/// 32 bytes of OS randomness, hex-encoded — the per-launch bridge secret.
fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("bridge: getrandom failed");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 16 bytes of OS randomness, hex-encoded — a forwarded-op request id.
fn random_id() -> String {
    let mut buf = [0u8; 16];
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
    // Merge (not blind replace): re-apply still-pending optimistic lock/version
    // overrides so a snapshot push racing a just-completed add-in checkout/checkin
    // can't revert it. Confirmed overrides are dropped inside apply_snapshot.
    state.apply_snapshot(snapshot);
    // Refresh the Explorer shell-extension cache so overlay icons / columns
    // track the vault without each shell handler hitting the HTTP API.
    state.write_shell_state();
}

/// The UI's reply to a forwarded blob op (`bridge://op`). `result` is whatever
/// the handler produced — `{ ok, error?, ... }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOpReply {
    pub id: String,
    #[serde(default)]
    pub result: Value,
}

/// Called by the UI after it runs a forwarded check-in / get-latest, to unblock
/// the waiting HTTP request.
#[tauri::command]
pub fn bridge_respond(state: State<'_, Arc<BridgeState>>, reply: BridgeOpReply) {
    state.resolve_pending(&reply.id, reply.result);
}

/// Is the SOLIDWORKS add-in currently connected? The frontend gates the
/// expensive vault-structure refresh on this so an idle session (no add-in)
/// stops re-pulling every file from Supabase on a timer.
#[tauri::command]
pub fn bridge_addin_active(state: State<'_, Arc<BridgeState>>) -> bool {
    state.addin_active()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sf(id: &str, path: &str, lock: Option<LockInfo>) -> SnapshotFile {
        SnapshotFile {
            file_id: id.into(),
            local_path: path.into(),
            name: path.rsplit(['/', '\\']).next().unwrap_or(path).into(),
            lock,
            ..Default::default()
        }
    }

    #[test]
    fn shell_state_maps_lock_to_state_by_normalized_path() {
        // Build straight from a Snapshot via the pure `build_shell_state` — no
        // BridgeState, no filesystem. Constructing a BridgeState would link the
        // bridge's reqwest/HTTP stack into the lib test binary, which on Windows
        // then can't launch as a bare test exe (STATUS_ENTRYPOINT_NOT_FOUND) and
        // fails `cargo test --workspace` for the whole crate.
        let snapshot = Snapshot {
            vault_root: Some("C:/Vault".into()),
            files: vec![
                sf("a", "C:/Vault/SDM26/Part.SLDPRT", Some(LockInfo { user_id: "me".into(), by_me: true })),
                sf("b", "C:\\Vault\\SDM26\\Other.SLDPRT", Some(LockInfo { user_id: "him".into(), by_me: false })),
                sf("c", "C:/Vault/SDM26/Free.SLDPRT", None),
            ],
        };

        let v = build_shell_state(&snapshot);
        let files = &v["files"];
        // Keys are normalized (backslash→/, lowercased) so the C# side matches.
        assert_eq!(files["c:/vault/sdm26/part.sldprt"]["state"], "out-me");
        assert!(files["c:/vault/sdm26/part.sldprt"]["by"].is_null()); // mine → no holder shown
        assert_eq!(files["c:/vault/sdm26/other.sldprt"]["state"], "out-other");
        assert_eq!(files["c:/vault/sdm26/other.sldprt"]["by"], "him");
        assert_eq!(files["c:/vault/sdm26/free.sldprt"]["state"], "available");
        assert_eq!(v["vaultRoot"], "C:/Vault");
    }

    #[test]
    fn addin_activity_window() {
        let idle = 90_000;
        // Never seen a request → not active.
        assert!(!is_active(0, 1_000_000, idle));
        // Seen recently → active.
        assert!(is_active(1_000_000, 1_000_000 + 30_000, idle));
        // Last request older than the window → idle again.
        assert!(!is_active(1_000_000, 1_000_000 + idle, idle));
        assert!(!is_active(1_000_000, 1_000_000 + idle + 1, idle));
    }

    #[test]
    fn lock_matches_equivalence() {
        let me = LockInfo { user_id: "me".into(), by_me: true };
        let me2 = LockInfo { user_id: "me".into(), by_me: true };
        let other = LockInfo { user_id: "him".into(), by_me: false };
        assert!(lock_matches(&None, &None));
        assert!(lock_matches(&Some(me.clone()), &Some(me2)));
        assert!(!lock_matches(&Some(me), &None));
        assert!(!lock_matches(&None, &Some(other.clone())));
        assert!(!lock_matches(
            &Some(LockInfo { user_id: "me".into(), by_me: true }),
            &Some(other)
        ));
    }

    #[test]
    fn snapshot_merge_preserves_unconfirmed_optimistic_lock() {
        // Drive `merge_snapshot` directly (no BridgeState — constructing one links
        // reqwest into the test binary, which on Windows can't launch as a bare
        // test exe). Simulates: bridge checkout marks f1 locked-by-me, then a
        // concurrent UI push still showing it unlocked must NOT revert the lock.
        let mut optimistic: HashMap<String, OptimisticOverride> = HashMap::new();
        optimistic.insert(
            "f1".into(),
            OptimisticOverride {
                lock: Some(Some(LockInfo { user_id: "me".into(), by_me: true })),
                latest_version_id: None,
                applied_ms: 1_000_000,
            },
        );

        // Stale UI push (still unlocked) — must be overridden back to locked-by-me.
        // All pushes here land inside the TTL window.
        let merged = merge_snapshot(
            Snapshot { vault_root: None, files: vec![sf("f1", "C:/v/a.SLDPRT", None)] },
            &mut optimistic,
            1_000_100,
        );
        assert_eq!(merged.files[0].lock.as_ref().map(|l| l.by_me), Some(true));
        assert_eq!(optimistic.len(), 1, "override stays until UI confirms");

        // UI catches up (now shows locked-by-me) — override confirmed + dropped.
        let merged = merge_snapshot(
            Snapshot {
                vault_root: None,
                files: vec![sf("f1", "C:/v/a.SLDPRT", Some(LockInfo { user_id: "me".into(), by_me: true }))],
            },
            &mut optimistic,
            1_000_200,
        );
        assert_eq!(merged.files[0].lock.as_ref().map(|l| l.by_me), Some(true));
        assert!(optimistic.is_empty(), "confirmed override is dropped");

        // A genuine later remote change (someone else takes it) now flows through.
        let merged = merge_snapshot(
            Snapshot {
                vault_root: None,
                files: vec![sf("f1", "C:/v/a.SLDPRT", Some(LockInfo { user_id: "him".into(), by_me: false }))],
            },
            &mut optimistic,
            1_000_300,
        );
        assert_eq!(
            merged.files[0].lock.as_ref().map(|l| l.user_id.clone()),
            Some("him".into())
        );
    }

    /// The forever-stale case: `/checkin` clears the lock optimistically, then a
    /// coworker checks the file out before the UI pushes. Every push now
    /// disagrees with the override, so without a TTL the bridge would keep
    /// re-clearing the lock and report the file available until app restart.
    #[test]
    fn never_confirmed_optimistic_override_expires() {
        let mut optimistic: HashMap<String, OptimisticOverride> = HashMap::new();
        optimistic.insert(
            "f1".into(),
            OptimisticOverride { lock: Some(None), latest_version_id: None, applied_ms: 1_000_000 },
        );
        let coworker = || Some(LockInfo { user_id: "him".into(), by_me: false });

        // Inside the TTL the override still wins (that's the race it exists for).
        let merged = merge_snapshot(
            Snapshot { vault_root: None, files: vec![sf("f1", "C:/v/a.SLDPRT", coworker())] },
            &mut optimistic,
            1_000_000 + OPTIMISTIC_TTL_MS - 1,
        );
        assert!(merged.files[0].lock.is_none());
        assert_eq!(optimistic.len(), 1);

        // Past the TTL it expires and the coworker's real lock shows through.
        let merged = merge_snapshot(
            Snapshot { vault_root: None, files: vec![sf("f1", "C:/v/a.SLDPRT", coworker())] },
            &mut optimistic,
            1_000_000 + OPTIMISTIC_TTL_MS,
        );
        assert_eq!(
            merged.files[0].lock.as_ref().map(|l| l.user_id.clone()),
            Some("him".into()),
            "expired override must stop hiding the real lock"
        );
        assert!(optimistic.is_empty(), "expired override is dropped");
    }

    /// Fields expire independently: a lock the UI has confirmed must not be
    /// resurrected on a later push just because the version pointer is still
    /// pending (an admin force-unlock would stay invisible).
    #[test]
    fn confirmed_lock_is_dropped_even_while_version_still_pending() {
        let mut optimistic: HashMap<String, OptimisticOverride> = HashMap::new();
        optimistic.insert(
            "f1".into(),
            OptimisticOverride {
                lock: Some(None),
                latest_version_id: Some("v2".into()),
                applied_ms: 1_000_000,
            },
        );

        // Push 1: lock agrees (both unlocked) → confirmed; version lags → pending.
        merge_snapshot(
            Snapshot { vault_root: None, files: vec![sf("f1", "C:/v/a.SLDPRT", None)] },
            &mut optimistic,
            1_000_100,
        );
        assert!(optimistic["f1"].lock.is_none(), "confirmed lock override cleared");
        assert_eq!(optimistic["f1"].latest_version_id.as_deref(), Some("v2"));

        // Push 2 (still inside the TTL): someone else now holds the lock — it
        // must flow through, not be re-cleared by the confirmed override.
        let merged = merge_snapshot(
            Snapshot {
                vault_root: None,
                files: vec![sf("f1", "C:/v/a.SLDPRT", Some(LockInfo { user_id: "him".into(), by_me: false }))],
            },
            &mut optimistic,
            1_000_200,
        );
        assert_eq!(
            merged.files[0].lock.as_ref().map(|l| l.user_id.clone()),
            Some("him".into())
        );
    }

    /// Ordinal (ASCII) case folding: U+212A KELVIN SIGN must NOT fold to `k`, or
    /// two paths NTFS treats as distinct collide and `file_by_path` can resolve
    /// a check-out to the wrong file.
    #[test]
    fn norm_path_folds_ascii_only() {
        assert_eq!(norm_path(r"C:\Vault\SDM26\Part.SLDPRT"), "c:/vault/sdm26/part.sldprt");
        assert_eq!(norm_path("C:/Vault/x/"), "c:/vault/x");
        let kelvin = "C:/Vault/\u{212A}elvin.sldprt";
        let latin_k = "C:/Vault/kelvin.sldprt";
        assert_ne!(norm_path(kelvin), norm_path(latin_k));
    }

    #[test]
    fn reconnect_detection() {
        let idle = 90_000;
        // First request ever is a (re)connect — triggers the immediate snapshot.
        assert!(reconnected(0, 1_000_000, idle));
        // A steady stream of requests is NOT a reconnect each time.
        assert!(!reconnected(1_000_000, 1_000_000 + 30_000, idle));
        // Coming back after going idle IS a reconnect.
        assert!(reconnected(1_000_000, 1_000_000 + idle, idle));
        assert!(reconnected(1_000_000, 1_000_000 + 5 * idle, idle));
    }
}
