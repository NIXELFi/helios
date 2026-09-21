//! Starting the simulator from Helios.
//!
//! The simulator is a separate executable with a documented command line, so
//! launching it is one `Command::spawn` and the interesting part is finding
//! it. Helios looks in the places a team actually keeps it, remembers where it
//! found it, and lets the user point at it by hand when they have put it
//! somewhere nobody would guess.
//!
//! The simulator is single-instance: a second launch focuses the running
//! window and hands it the new arguments. So "launch a run" and "watch a
//! replay" are the same call with different flags, whether or not it is
//! already open.
//!
//! That is also the trap. A second process forwards its arguments to the
//! first and then EXITS, within a fraction of a second -- so the child Helios
//! spawned is not the simulator, it is a messenger. Treating its exit as the
//! end of a session put a "your session is over" card over the top of a replay
//! that was just starting, and then a second one when the real session ended.
//! `watch_child` is where that is handled: only the process that actually
//! opened the window is watched, and a replay is never watched at all.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

const EXE_NAME: &str = if cfg!(windows) { "fsae-sim.exe" } else { "fsae-sim" };
const SETTINGS_FILE: &str = "sim.json";

/// Where this machine remembers its copy of the simulator.
///
/// Off `helios_data_dir()`, NOT off the runs directory. The runs directory is
/// team data and `HELIOS_SIM_RUNS_DIR` is meant to point it at a shared drive
/// -- and deriving this from it meant that every rig on that share then wrote
/// its own local exe path into one shared `sim.json`, each one overwriting
/// the last. Where the simulator is installed is a fact about this computer.
fn settings_path() -> PathBuf {
    super::runs::helios_data_dir().join(SETTINGS_FILE)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimSettings {
    /// Where the user said the simulator is. Wins over every guess.
    #[serde(default)]
    exe_path: Option<String>,
}

fn read_settings() -> SimSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_settings(s: &SimSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Every place worth looking for the simulator, in the order a team would
/// expect: what the user set, what the environment says, an installed copy,
/// then a developer checkout beside or under the home directory.
fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    if let Some(p) = read_settings().exe_path {
        out.push(PathBuf::from(p));
    }
    if let Some(p) = std::env::var_os("FSAE_SIM_EXE") {
        out.push(PathBuf::from(p));
    }

    // An installed build.
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(key) {
            let b = PathBuf::from(base);
            out.push(b.join("SDM26 Driver-in-Loop").join(EXE_NAME));
            out.push(b.join("fsae-sim").join(EXE_NAME));
            out.push(b.join("Programs").join("SDM26 Driver-in-Loop").join(EXE_NAME));
        }
    }

    // A developer checkout. Both build profiles, both the conventional clone
    // location and a sibling of the Helios checkout.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        roots.push(home.join("fsae-sim"));
        roots.push(home.join("Documents").join("fsae-sim"));
        roots.push(home.join("src").join("fsae-sim"));
    }
    // A developer checkout beside the Helios one. This used to walk eight
    // parents up from `current_exe()`, which for an installed Helios under
    // `C:\Program Files\` reaches the root of the system drive -- and the
    // default ACL on `C:\` lets any authenticated user create a folder there.
    // `sim_status` RUNS what it finds (`--version`), so that walk let an
    // unprivileged user on a shared rig get code executed by everybody else's
    // Helios. Only paths under the user's own profile are searched now.
    if let (Ok(exe), Some(home)) = (std::env::current_exe(), home_dir()) {
        let mut p = exe.as_path();
        for _ in 0..8 {
            let Some(parent) = p.parent() else { break };
            if parent.starts_with(&home) {
                roots.push(parent.join("fsae-sim"));
            }
            p = parent;
        }
    }
    for r in roots {
        for profile in ["release", "debug"] {
            out.push(r.join("sim").join("src-tauri").join("target").join(profile).join(EXE_NAME));
        }
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The first candidate that exists.
fn find_exe() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|p| p.is_file())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimStatus {
    /// The simulator executable, if one was found.
    pub exe_path: Option<String>,
    /// True when the path came from the user rather than from a guess, so the
    /// UI can say "configured" instead of "found".
    pub exe_configured: bool,
    pub version: Option<String>,
    pub runs_dir: String,
    /// How many runs are already filed. Saves the UI a second round trip just
    /// to decide whether to show an empty state.
    pub run_count: usize,
    /// Everywhere that was looked, so a user whose copy was not found can see
    /// why rather than guess.
    pub searched: Vec<String>,
}

// `async`: a bare `#[tauri::command]` on a sync fn runs on the IPC thread,
// and this one stats a directory and may run `fsae-sim --version` with a
// deadline. The macro routes it to the blocking pool instead.
#[tauri::command(async)]
pub fn sim_status() -> SimStatus {
    let configured = read_settings().exe_path;
    // Computed once: this used to call `candidate_paths()` (and through it
    // `read_settings()`) twice per status, and the Sim module polls status
    // every six seconds.
    let searched = candidate_paths();
    let exe = searched.iter().find(|p| p.is_file()).cloned();
    let version = exe.as_deref().and_then(exe_version);
    // Counted from the directory, not by listing. `sim_list_runs` parses
    // every manifest on disk, and this is polled every six seconds for as
    // long as the Sim tab is open; the UI only wants to know whether the
    // archive is empty.
    let run_count = super::runs::run_count();
    SimStatus {
        exe_configured: configured
            .as_deref()
            .map(|c| exe.as_deref().map(|e| e == Path::new(c)).unwrap_or(false))
            .unwrap_or(false),
        exe_path: exe.map(|p| p.display().to_string()),
        version,
        runs_dir: super::runs::runs_root().display().to_string(),
        run_count,
        searched: searched.iter().map(|p| p.display().to_string()).collect(),
    }
}

/// The last version read, keyed on the executable's path and modification
/// time. `sim_status` is polled every six seconds for as long as the Sim tab
/// is open, and without this each poll spawns a process.
static VERSION_CACHE: Mutex<Option<(PathBuf, SystemTime, Option<String>)>> = Mutex::new(None);

/// `fsae-sim --version` prints one line and exits without opening a window.
///
/// This RUNS the file it was given, so what may be handed to it matters --
/// see the note in `candidate_paths`. It is also given a deadline: a hung
/// binary would otherwise block a Tauri command worker forever while the
/// six-second poll queued another behind it.
fn exe_version(exe: &Path) -> Option<String> {
    let stamp = fs::metadata(exe).and_then(|m| m.modified()).ok()?;
    {
        let cache = VERSION_CACHE.lock().ok()?;
        if let Some((p, t, v)) = cache.as_ref() {
            if p == exe && *t == stamp {
                return v.clone();
            }
        }
    }
    let version = run_version(exe);
    if let Ok(mut cache) = VERSION_CACHE.lock() {
        *cache = Some((exe.to_path_buf(), stamp, version.clone()));
    }
    version
}

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

fn run_version(exe: &Path) -> Option<String> {
    let mut child = Command::new(exe)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            // It is not going to answer. Stop it rather than leaving it.
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// Re-run the search, for a "find it again" button.
#[tauri::command]
pub fn sim_locate_exe() -> Option<String> {
    find_exe().map(|p| p.display().to_string())
}

/// Remember where the user says the simulator is. Passing null forgets it and
/// falls back to the search.
#[tauri::command]
pub fn sim_set_exe_path(path: Option<String>) -> Result<SimStatus, String> {
    let cleaned = path.map(|p| p.trim().trim_matches('"').to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &cleaned {
        let pb = PathBuf::from(p);
        if !pb.is_file() {
            return Err(format!("no file at {p}"));
        }
    }
    write_settings(&SimSettings { exe_path: cleaned })?;
    Ok(sim_status())
}

// ------------------------------------------------------------------ launch --

/// What Helios asks the simulator to do. Every field is optional; the
/// simulator's own launch screen fills in whatever is left out.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub track: Option<String>,
    pub profile: Option<String>,
    pub driver: Option<String>,
    /// The signed-in Helios account id for that driver. It is what makes a lap
    /// time attributable to a person rather than to whatever was typed in a
    /// box, so a DRIVE requires one; a replay does not.
    pub driver_id: Option<String>,
    pub session: Option<String>,
    pub traction: Option<bool>,
    pub abs: Option<bool>,
    pub auto_shift: Option<bool>,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub windowed: bool,
    #[serde(default)]
    pub no_record: bool,
    /// Open a recorded run instead of a drive.
    pub replay: Option<String>,
    /// A second recorded run to draw alongside the replay.
    pub ghost: Option<String>,
    /// A recorded run whose best lap the live delta counts against, so the
    /// driver is chasing a real lap from the first corner instead of from
    /// lap two.
    pub reference: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub exe_path: String,
    pub args: Vec<String>,
    pub pid: u32,
}

/// The simulator's own choices are enums and its parser reports anything it
/// does not understand, but a value from the renderer should not reach a
/// command line unvalidated in the first place.
fn valid_track(t: &str) -> bool {
    matches!(t, "autocross" | "endurance" | "mis") || valid_generated_track(t)
}

/// A procedural course: `gen-ax-SEED` or `gen-en-SEED`, the seed being the
/// simulator's canonical form -- letters, digits and dashes, at most twelve.
/// The simulator normalises what it is given, but a value that reaches its
/// command line should already be one it would accept.
fn valid_generated_track(t: &str) -> bool {
    let seed = match t.strip_prefix("gen-ax-").or_else(|| t.strip_prefix("gen-en-")) {
        Some(s) => s,
        None => return false,
    };
    !seed.is_empty()
        && seed.len() <= 12
        && seed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn valid_profile(p: &str) -> bool {
    p.len() <= 32 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        // A leading `-` would be read as a flag by the simulator's own
        // argument parser, not as the value of `--replay`.
        && !id.starts_with('-')
        && !id.starts_with('.')
}

/// A Supabase account id is a UUID. Anything else is not one, and must not
/// reach a command line pretending to be an identity.
fn valid_account_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() }
        })
}

/// Free text (a driver's name, a session label) that is going onto a command
/// line. Control characters and quotes come out; the length is bounded.
///
/// And it may not begin with a dash, for the same reason `valid_run_id`
/// refuses one: the simulator's argument parser would read the VALUE of
/// `--driver` as another flag. A display name is user-supplied text and this
/// is the one function whose job is making it safe to hand to a process.
fn clean_text(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() && *c != '"')
        .take(max)
        .collect::<String>()
        .trim()
        .trim_start_matches('-')
        .trim()
        .to_string()
}

pub(crate) fn build_args(req: &LaunchRequest) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();

    if let Some(run) = &req.replay {
        if !valid_run_id(run) {
            return Err(format!("not a run id: {run}"));
        }
        args.push("--replay".into());
        args.push(run.clone());
        if let Some(g) = &req.ghost {
            if !valid_run_id(g) {
                return Err(format!("not a run id: {g}"));
            }
            args.push("--ghost".into());
            args.push(g.clone());
        }
        // A replay is not a drive: none of the session flags mean anything,
        // and `--autostart` would put the driver on the grid instead.
        if req.windowed {
            args.push("--windowed".into());
        }
        return Ok(args);
    }

    if let Some(t) = &req.track {
        if !valid_track(t) {
            return Err(format!("no course called {t}"));
        }
        args.push("--track".into());
        args.push(t.clone());
    }
    if let Some(p) = &req.profile {
        if !valid_profile(p) {
            return Err(format!("not a control profile: {p}"));
        }
        args.push("--profile".into());
        args.push(p.clone());
    }
    // A drive has to be attributable. The UI disables the button when signed
    // out, but that is a courtesy, not a guarantee -- this is the guarantee.
    // (A replay returned above and needs no driver.)
    let driver = req.driver.as_deref().map(|d| clean_text(d, 64)).unwrap_or_default();
    if driver.is_empty() || req.driver_id.is_none() {
        return Err("a run needs a signed-in Helios driver".into());
    }
    args.push("--driver".into());
    args.push(driver);
    if let Some(id) = &req.driver_id {
        if !valid_account_id(id) {
            return Err(format!("not an account id: {id}"));
        }
        args.push("--driver-id".into());
        args.push(id.clone());
    }
    if let Some(s) = &req.session {
        let s = clean_text(s, 96);
        if !s.is_empty() {
            args.push("--session".into());
            args.push(s);
        }
    }
    if let Some(v) = req.traction {
        args.push("--tc".into());
        args.push(if v { "on".into() } else { "off".into() });
    }
    if let Some(v) = req.abs {
        args.push("--abs".into());
        args.push(if v { "on".into() } else { "off".into() });
    }
    if let Some(v) = req.auto_shift {
        args.push("--auto-shift".into());
        args.push(if v { "on".into() } else { "off".into() });
    }
    if let Some(r) = &req.reference {
        if !valid_run_id(r) {
            return Err(format!("not a run id: {r}"));
        }
        args.push("--reference".into());
        args.push(r.clone());
    }
    if req.no_record {
        args.push("--no-record".into());
    }
    if req.autostart {
        args.push("--autostart".into());
    }
    if req.windowed {
        args.push("--windowed".into());
    }
    Ok(args)
}

/// Emitted when a simulator that Helios started has exited.
///
/// Helios does not need to watch the runs directory to know what a session
/// produced: a run id begins with the timestamp it started at, so the runs
/// written between `started_at` and `ended_at` ARE the session. That keeps the
/// knowledge on the side that has it -- the process handle -- instead of
/// guessing from file times.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimExited {
    pub pid: u32,
    /// Milliseconds since the epoch, which is what `Date` takes on the other
    /// side. An RFC3339 string would have to be parsed back immediately.
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    /// The process's exit code, when it had one.
    pub code: Option<i32>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Start the simulator, or hand a new request to the copy already running.
// `async`: spawning a process and stat-ing the search paths is not work for
// the IPC thread.
#[tauri::command(async)]
pub fn sim_launch(app: tauri::AppHandle, request: LaunchRequest) -> Result<LaunchResult, String> {
    let exe = find_exe().ok_or_else(|| {
        "could not find fsae-sim. Set its location in the Sim module's settings.".to_string()
    })?;
    let args = build_args(&request)?;

    let mut cmd = Command::new(&exe);
    cmd.args(&args);
    // Run it from its own directory: the simulator resolves its bundled data
    // relative to the executable, but a working directory inherited from
    // Helios is a surprise nobody needs.
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    // Both halves agree on where runs go even when this machine overrides it,
    // so a Helios pointed at a shared drive gets runs written to that drive.
    if let Some(v) = std::env::var_os("HELIOS_SIM_RUNS_DIR") {
        cmd.env("FSAE_SIM_RUNS_DIR", v);
    }
    #[cfg(windows)]
    {
        // No console window flashing up behind the game.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    let pid = child.id();
    let started_at_ms = now_ms();

    watch_child(app, child, pid, started_at_ms, request.replay.is_some());

    Ok(LaunchResult {
        exe_path: exe.display().to_string(),
        args,
        pid,
    })
}

/// The event name both sides agree on.
pub const SIM_EXITED_EVENT: &str = "sim://exited";

/// The process that owns the simulator's window, while one is open.
///
/// The simulator is single-instance: the first process to start is the
/// window, and every launch after it is a messenger that hands its arguments
/// to that window and exits within about a hundred milliseconds. So the
/// process to wait on is the WINDOW, whatever it was opened for -- which is
/// what this used to get wrong. A replay was never registered here, so a
/// drive sent into a window a replay had opened found nothing watched,
/// registered itself, and announced its own exit a hundred milliseconds later:
/// the session-summary card came up over an empty window with the driver
/// still on the grid, and when the real window finally closed, nothing said
/// so. Reachable from "Watch that lap" followed by "Drive against this lap".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Watched {
    pid: u32,
    /// Whether this window's exit ends a session worth announcing. A window
    /// opened for a replay starts false -- announcing one put "the simulator
    /// closed without filing a run" over a replay that had just opened -- and
    /// turns true the moment a drive is sent into it.
    announce: bool,
    /// When the session began: the first DRIVE, which for a window a replay
    /// opened is later than the window.
    started_at_ms: u64,
}

static WATCHED: Mutex<Option<Watched>> = Mutex::new(None);

/// What a freshly spawned child is, given what is already being watched.
#[derive(Debug, PartialEq, Eq)]
enum Role {
    /// This child is the window. Its exit is the one that matters.
    Window,
    /// The window is already open; this child only carried a message to it
    /// and will exit at once, which means nothing.
    Messenger,
}

/// Register a spawned child. Pure, so the policy can be tested without a
/// process or an `AppHandle` -- the latter cannot be reached from a unit test
/// on Windows without linking the whole GUI stack.
fn claim(watched: &mut Option<Watched>, pid: u32, started_at_ms: u64, is_replay: bool) -> Role {
    match watched {
        None => {
            *watched = Some(Watched { pid, announce: !is_replay, started_at_ms });
            Role::Window
        }
        Some(w) => {
            // A drive into a window that a replay opened makes that window a
            // session: its exit now matters, and the session began now.
            if !is_replay && !w.announce {
                w.announce = true;
                w.started_at_ms = started_at_ms;
            }
            Role::Messenger
        }
    }
}

/// A child has exited. If it was the window, hand back what was being watched
/// so the caller can decide whether to announce; anything else says nothing.
fn release(watched: &mut Option<Watched>, pid: u32) -> Option<Watched> {
    match watched {
        Some(w) if w.pid == pid => watched.take(),
        _ => None,
    }
}

/// Wait for a spawned simulator and, if it was the window and a drive went
/// into it, say so when it goes.
///
/// Every child is waited on -- that is what reaps it on Unix, and without it
/// the process lingers as a zombie. Only the window is allowed to ANNOUNCE
/// anything, and only if a drive happened in it; see `Watched` for the two
/// reasons and the bug they were learned from.
fn watch_child(
    app: tauri::AppHandle,
    mut child: std::process::Child,
    pid: u32,
    started_at_ms: u64,
    is_replay: bool,
) {
    let role = claim(&mut WATCHED.lock().unwrap(), pid, started_at_ms, is_replay);
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|st| st.code());
        if role != Role::Window {
            return;
        }
        let Some(w) = release(&mut WATCHED.lock().unwrap(), pid) else { return };
        if !w.announce {
            return;
        }
        let payload = SimExited { pid, started_at_ms: w.started_at_ms, ended_at_ms: now_ms(), code };
        // A failure here is not worth surfacing: the window may simply have
        // gone before the simulator did.
        let _ = tauri::Emitter::emit(&app, SIM_EXITED_EVENT, payload);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "8f14e45f-ceea-467a-9c1e-1b2c3d4e5f60";

    /// An empty request. Note it has NO driver: a drive needs one, so tests
    /// about drives add it, and tests about replays deliberately do not.
    fn req() -> LaunchRequest { LaunchRequest::default() }

    /// The minimum a drive needs: a signed-in driver.
    fn drive() -> LaunchRequest {
        LaunchRequest { driver: Some("Nick".into()), driver_id: Some(ID.into()), ..req() }
    }

    /// The window's exit is the session's end, whatever the window was opened
    /// for. "Watch that lap" then "Drive against this lap" is a replay window
    /// receiving a drive: the drive's own process is a messenger that exits at
    /// once, and announcing THAT put the session summary over a driver still
    /// sitting on the grid.
    #[test]
    fn a_drive_sent_into_a_replays_window_is_announced_when_that_window_closes() {
        let mut w = None;
        assert_eq!(claim(&mut w, 10, 1_000, true), Role::Window);
        assert_eq!(claim(&mut w, 11, 2_000, false), Role::Messenger);
        // The messenger's exit says nothing...
        assert_eq!(release(&mut w, 11), None);
        assert!(w.is_some(), "the window is still being watched");
        // ...and the window's exit says a session ended, timed from the drive.
        let ended = release(&mut w, 10).expect("the window's exit is the session's end");
        assert!(ended.announce);
        assert_eq!(ended.started_at_ms, 2_000, "the session began with the drive, not the replay");
        assert!(w.is_none(), "nothing left watched once the window has gone");
    }

    #[test]
    fn a_replay_on_its_own_is_never_announced() {
        let mut w = None;
        assert_eq!(claim(&mut w, 10, 1_000, true), Role::Window);
        let ended = release(&mut w, 10).unwrap();
        assert!(!ended.announce, "a replay is not a session");
    }

    #[test]
    fn a_second_drive_is_a_messenger_and_the_session_keeps_its_start() {
        let mut w = None;
        assert_eq!(claim(&mut w, 10, 1_000, false), Role::Window);
        assert_eq!(claim(&mut w, 11, 5_000, false), Role::Messenger);
        let ended = release(&mut w, 10).unwrap();
        assert_eq!(ended.started_at_ms, 1_000);
        // And once the window has gone, the next drive owns a new session.
        assert_eq!(claim(&mut w, 12, 9_000, false), Role::Window);
        assert_eq!(release(&mut w, 12).unwrap().started_at_ms, 9_000);
    }

    #[test]
    fn builds_a_drive_command_line() {
        let r = LaunchRequest {
            track: Some("autocross".into()),
            profile: Some("wheel".into()),
            driver: Some("Nick Murray".into()),
            driver_id: Some("8f14e45f-ceea-467a-9c1e-1b2c3d4e5f60".into()),
            session: Some("Tuesday test".into()),
            traction: Some(false),
            abs: Some(true),
            autostart: true,
            ..req()
        };
        assert_eq!(
            build_args(&r).unwrap(),
            vec![
                "--track", "autocross", "--profile", "wheel",
                "--driver", "Nick Murray",
                "--driver-id", "8f14e45f-ceea-467a-9c1e-1b2c3d4e5f60",
                "--session", "Tuesday test",
                "--tc", "off", "--abs", "on", "--autostart",
            ]
        );
    }

    #[test]
    fn a_replay_drops_the_session_flags() {
        let r = LaunchRequest {
            replay: Some("20260918-142233-autocross-9f3a".into()),
            ghost: Some("20260918-150000-autocross-bbbb".into()),
            // All of these are meaningless for a replay and must not be sent:
            // `--autostart` in particular would start a DRIVE.
            track: Some("endurance".into()),
            driver: Some("Nick".into()),
            autostart: true,
            traction: Some(true),
            ..req()
        };
        assert_eq!(
            build_args(&r).unwrap(),
            vec![
                "--replay", "20260918-142233-autocross-9f3a",
                "--ghost", "20260918-150000-autocross-bbbb",
            ]
        );
    }

    #[test]
    fn a_reference_lap_rides_along_with_a_drive() {
        let r = LaunchRequest {
            track: Some("autocross".into()),
            reference: Some("20260918-142233-autocross-9f3a".into()),
            autostart: true,
            ..drive()
        };
        assert_eq!(
            build_args(&r).unwrap(),
            vec![
                "--track", "autocross", "--driver", "Nick", "--driver-id", ID,
                "--reference", "20260918-142233-autocross-9f3a", "--autostart",
            ]
        );
    }

    #[test]
    fn a_reference_that_is_really_a_path_is_refused() {
        let r = LaunchRequest { reference: Some("../../etc".into()), ..drive() };
        assert!(build_args(&r).is_err());
    }

    #[test]
    fn rejects_a_course_that_does_not_exist() {
        let r = LaunchRequest { track: Some("nurburgring".into()), ..drive() };
        assert!(build_args(&r).is_err());
    }

    #[test]
    fn accepts_a_generated_course_by_seed() {
        for ok in ["gen-ax-K7Q2", "gen-en-SDM26", "gen-ax-A-B-1", "gen-en-abcdefghjkmn"] {
            let r = LaunchRequest { track: Some(ok.into()), ..drive() };
            let args = build_args(&r).expect(ok);
            assert!(args.windows(2).any(|w| w[0] == "--track" && w[1] == ok), "{ok}");
        }
        for bad in ["gen-ax-", "gen-xx-K7Q2", "gen-ax-abcdefghjkmnp", "gen-ax-K7 Q2", "gen-ax-../x"] {
            let r = LaunchRequest { track: Some(bad.into()), ..drive() };
            assert!(build_args(&r).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_run_ids_that_are_really_paths() {
        for bad in ["../../etc/passwd", "a/b", "a\\b", "", "-rf"] {
            let r = LaunchRequest { replay: Some(bad.into()), ..req() };
            assert!(build_args(&r).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn a_drivers_name_cannot_smuggle_in_a_flag_or_a_newline() {
        let r = LaunchRequest {
            driver: Some("Nick\n--windowed \"; rm -rf /".into()),
            ..drive()
        };
        let all = build_args(&r).unwrap();
        // The command line is `--driver <name> --driver-id <id>`; the name is
        // the pair this test is about.
        assert_eq!(all.len(), 4);
        assert_eq!(all[0], "--driver");
        assert_eq!(all[2], "--driver-id");
        // The name is ONE argument -- `Command` passes arguments as a vector,
        // not through a shell, so a space or a quote in a name is only ever
        // part of that name. What is checked here is that the control
        // characters and quotes are gone and nothing extra appeared.
        assert!(!all[1].contains('\n'));
        assert!(!all[1].contains('"'));
    }

    #[test]
    fn an_account_id_must_be_a_uuid() {
        for bad in ["nick", "", "../../etc", "8f14e45f-ceea-467a-9c1e-1b2c3d4e5f6", "not-a-uuid-at-all-x"] {
            let r = LaunchRequest { driver_id: Some(bad.into()), ..drive() };
            assert!(build_args(&r).is_err(), "{bad} should be rejected");
        }
        let good = LaunchRequest {
            driver_id: Some("8F14E45F-CEEA-467A-9C1E-1B2C3D4E5F60".into()), ..drive()
        };
        assert!(build_args(&good).is_ok(), "an uppercase UUID is still a UUID");
    }

    /// The whole leaderboard rests on a run being attributable, so this is
    /// enforced here and not only by a disabled button in the UI.
    #[test]
    fn a_drive_without_a_signed_in_driver_is_refused() {
        for r in [
            LaunchRequest { track: Some("autocross".into()), ..req() },
            LaunchRequest { driver: Some("Nick".into()), ..req() },
            LaunchRequest { driver_id: Some(ID.into()), ..req() },
            LaunchRequest { driver: Some("   ".into()), driver_id: Some(ID.into()), ..req() },
        ] {
            let err = build_args(&r).unwrap_err();
            assert!(err.contains("signed-in"), "got: {err}");
        }
    }

    /// A replay is not a drive: it needs no driver at all.
    #[test]
    fn a_replay_needs_no_driver() {
        let r = LaunchRequest { replay: Some("20260918-142233-autocross-9f3a".into()), ..req() };
        assert!(build_args(&r).is_ok());
    }

    #[test]
    fn a_very_long_name_is_bounded() {
        let r = LaunchRequest { driver: Some("x".repeat(500)), driver_id: Some(ID.into()), ..req() };
        let args = build_args(&r).unwrap();
        assert_eq!(args[1].len(), 64);
    }

    #[test]
    fn a_bare_drive_asks_only_for_its_driver() {
        assert_eq!(build_args(&drive()).unwrap(), vec!["--driver", "Nick", "--driver-id", ID]);
    }

    #[test]
    fn the_search_looks_in_the_obvious_places() {
        let paths = candidate_paths();
        assert!(!paths.is_empty());
        assert!(paths.iter().all(|p| p.file_name().map(|n| n == EXE_NAME).unwrap_or(false)),
                "every candidate must name the simulator executable");
    }
}
