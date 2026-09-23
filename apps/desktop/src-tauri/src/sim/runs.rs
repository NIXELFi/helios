//! Reading the simulator's run archive.
//!
//! Every run is a directory holding a manifest and a telemetry CSV. Listing is
//! manifest-only and deliberately cheap: a season of runs is a few thousand
//! small JSON files, and the Runs table, the per-course leaderboards and the
//! driver comparison are all built from what is in them. Nothing reads a
//! telemetry file until somebody asks to open or replay one.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const RUNS_SUBDIR: &str = "sim-runs";
const MANIFEST: &str = "run.json";
const TELEMETRY: &str = "telemetry.csv";

/// Where the simulator files its runs. Two environment overrides, because the
/// simulator reads `FSAE_SIM_RUNS_DIR` and a machine that has set that has
/// meant it for both halves.
pub fn runs_root() -> PathBuf {
    for key in ["HELIOS_SIM_RUNS_DIR", "FSAE_SIM_RUNS_DIR"] {
        if let Some(v) = std::env::var_os(key) {
            let p = PathBuf::from(v);
            if !p.as_os_str().is_empty() {
                return p;
            }
        }
    }
    helios_data_dir().join(RUNS_SUBDIR)
}

/// `%LOCALAPPDATA%\Helios`, or the platform equivalent.
///
/// Per-MACHINE state lives under here. Deliberately not derived from
/// `runs_root()`: that one honours `HELIOS_SIM_RUNS_DIR`, which is meant to
/// point a whole team's runs at a shared drive, and anything hung off its
/// parent then becomes shared too -- which is wrong for an installed
/// executable and actively broken for "where is my copy of the simulator".
pub(crate) fn helios_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let p = PathBuf::from(local);
            if !p.as_os_str().is_empty() {
                return p.join("Helios");
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let p = PathBuf::from(home);
            if !p.as_os_str().is_empty() {
                return p.join("Library").join("Application Support").join("Helios");
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let p = PathBuf::from(xdg);
            if !p.as_os_str().is_empty() {
                return p.join("Helios");
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            let p = PathBuf::from(home);
            if !p.as_os_str().is_empty() {
                return p.join(".local").join("share").join("Helios");
            }
        }
    }
    std::env::temp_dir().join("Helios")
}

/// A run id is a directory name and arrives from the renderer, so it must not
/// be able to climb out of the runs directory.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !id.starts_with('.')
}

fn run_dir(id: &str) -> Result<PathBuf, String> {
    if !is_safe_id(id) {
        return Err(format!("not a run id: {id}"));
    }
    Ok(runs_root().join(id))
}

// ---------------------------------------------------------------- manifest --

/// The parts of a run manifest a listing needs. Everything else in the file is
/// passed through untouched by `sim_read_run`; this is only what the table,
/// the leaderboard and the sorting are built from.
///
/// Every field is optional or defaulted. A manifest written by a newer
/// simulator than this build must still list, because the alternative is a
/// Runs table that empties itself the day somebody updates one rig.
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    /// Which shape the derived numbers are in. See `RunRow::format_version`.
    #[serde(default, rename = "formatVersion")]
    format_version: Option<u32>,
    /// The rate the log was ACTUALLY written at. `sampleRateHz` is the target;
    /// a machine rendering below it logs at the frame rate instead.
    #[serde(default, rename = "sampleRateActualHz")]
    sample_rate_actual_hz: Option<f64>,
    #[serde(default, rename = "sampleRateHz")]
    sample_rate_hz: Option<f64>,
    #[serde(default)]
    driver: Option<String>,
    #[serde(default, rename = "driverId")]
    driver_id: Option<String>,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    track: Option<String>,
    #[serde(default, rename = "trackName")]
    track_name: Option<String>,
    #[serde(default, rename = "startedAt")]
    started_at: Option<String>,
    #[serde(default, rename = "finishedReason")]
    finished_reason: Option<String>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default, rename = "profileName")]
    profile_name: Option<String>,
    /// What actually steered, as the simulator observed it frame by frame --
    /// "wheel", "controller" or "keyboard". `profile` is the dropdown the
    /// driver picked; this is the device the car was steered by, and the
    /// leaderboards prefer it. Absent on runs recorded before it existed.
    #[serde(default, rename = "detectedInput")]
    detected_input: Option<String>,
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    physics: Option<String>,
    #[serde(default, rename = "simVersion")]
    sim_version: Option<String>,
    #[serde(default)]
    synthetic: bool,
    #[serde(default)]
    samples: u64,
    #[serde(default)]
    assists: Option<Assists>,
    #[serde(default)]
    laps: Vec<Lap>,
    #[serde(default)]
    stats: Option<Stats>,
    // What a run from BEFORE simulator 0.7.2 says about its car, for
    // `legacy_class`: whether its time counted as the simulator judged it at
    // the start of the run, what was off as-shipped, and every parameter.
    #[serde(default)]
    counted: Option<bool>,
    #[serde(default, rename = "modelChanges")]
    model_changes: Option<Vec<ModelChange>>,
    #[serde(default)]
    car: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelChange {
    #[serde(default)]
    path: String,
}

/// Which model drove a run and whether it counts, for a run from before
/// simulator 0.7.2, which did not put either in `stats`.
///
/// Those builds counted the 4-wheel beta as a MODIFIED car, so its manifest
/// says `counted: false` with `vehicleModel` among `modelChanges` -- and
/// Helios, which never read that flag, ranked such runs as ordinary bicycle
/// times. Since 0.7.2 the model is a class with its own board, so here it is
/// read off the car snapshot, and the run counts unless something OTHER than
/// the model was changed.
fn legacy_class(stats: &mut Stats, counted: Option<bool>, changes: Option<&[ModelChange]>, car: Option<&serde_json::Value>) {
    if stats.vehicle_model.is_none() {
        stats.vehicle_model = car
            .and_then(|c| c.get("vehicleModel"))
            .and_then(|v| v.as_f64())
            .map(|v| if v >= 2.5 { 3 } else { 2 });
    }
    if stats.counted.is_none() {
        stats.counted = match changes {
            Some(list) => Some(list.iter().all(|c| c.path == "vehicleModel")),
            None => counted,
        };
    }
}

/// Simulators 0.7.2-0.7.4 marked a whole run `counted: false` when any lap
/// was uncounted -- and an off-course lap is always uncounted, so one off in
/// an endurance stint took every real time in the run off the board as if
/// the car had been modified. The laps say which it was: when every
/// uncounted lap is one that left the course (no time anyway), the run was
/// started on a legal car, and one model drove it all, it counts.
fn unvoid_off_laps(stats: &mut Stats, header_counted: Option<bool>, laps: &[Lap]) {
    if stats.counted != Some(false) || header_counted == Some(false) || laps.is_empty() {
        return;
    }
    // Only a run whose laps carry the verdict (0.7.2+) can be read this way.
    if laps.iter().any(|l| l.counted.is_none()) {
        return;
    }
    let one_model = laps.windows(2).all(|w| w[0].vehicle_model == w[1].vehicle_model);
    if one_model && laps.iter().all(|l| !l.valid || l.counted != Some(false)) {
        stats.counted = Some(true);
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Assists {
    #[serde(default)]
    pub traction: bool,
    #[serde(default)]
    pub abs: bool,
    #[serde(default, rename = "autoShift")]
    pub auto_shift: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Lap {
    #[serde(default)]
    pub lap: u32,
    #[serde(default)]
    pub raw: f64,
    #[serde(default)]
    pub cones: u32,
    #[serde(default)]
    pub off: u32,
    #[serde(default)]
    pub total: f64,
    /// Did this lap score a time?
    ///
    /// False when it left the course, which does not score here -- see the
    /// note in the simulator's `timing.js`, which is stricter than FSAE and
    /// says why. Defaults TRUE so a manifest written before the field existed
    /// keeps the meaning it had: back then every completed lap scored.
    ///
    /// It has to be in this struct even though nothing in Rust reads it,
    /// because this is where a manifest is parsed on its way to the renderer
    /// and anything absent here is silently dropped -- which is how a lap
    /// reached the team's shared archive with its `off` count intact and no
    /// record of having been invalidated.
    #[serde(default = "yes")]
    pub valid: bool,
    /// Whether the car was one this lap could be driven in (simulator
    /// 0.7.2+). Absent before; see `unvoid_off_laps`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counted: Option<bool>,
    #[serde(default, rename = "vehicleModel", skip_serializing_if = "Option::is_none")]
    pub vehicle_model: Option<u8>,
    #[serde(default, rename = "physicsRev", skip_serializing_if = "Option::is_none")]
    pub physics_rev: Option<u32>,
    /// The clock time the lap took where that is not `raw` (the skidpad,
    /// whose score is an average; simulator 0.7.5+).
    #[serde(default, rename = "spanS", skip_serializing_if = "Option::is_none")]
    pub span_s: Option<f64>,
    /// `null` for a sector that was never timed (the car's course distance
    /// jumped over the boundary). As `Vec<f64>` a single one failed the whole
    /// manifest, and the run silently vanished from the list and the board.
    #[serde(default)]
    pub sectors: Vec<Option<f64>>,
    /// Cones struck in each sector, aligned with `sectors` (manifest format
    /// 4+). Dropped here before, so no shared lap had it and any sector with
    /// a cone in it could not count toward a sector record.
    #[serde(default, rename = "sectorCones", skip_serializing_if = "Option::is_none")]
    pub sector_cones: Option<Vec<Option<u32>>>,
    #[serde(default, rename = "startedAtS")]
    pub started_at_s: f64,
}

fn yes() -> bool { true }

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(default)]
    pub duration_s: f64,
    #[serde(default)]
    pub distance_m: f64,
    #[serde(default)]
    pub laps: u32,
    #[serde(default)]
    pub best_lap_s: Option<f64>,
    /// The raw time of the BEST SCORED lap, not the quickest raw lap in the
    /// run. Those are different laps whenever the quick one had cones on it.
    #[serde(default)]
    pub best_lap_raw_s: Option<f64>,
    #[serde(default)]
    pub best_lap_number: Option<u32>,
    #[serde(default)]
    pub best_lap_cones: Option<u32>,
    #[serde(default)]
    pub fastest_raw_lap_s: Option<f64>,
    #[serde(default)]
    pub fastest_raw_lap_number: Option<u32>,
    #[serde(default)]
    pub best_sectors: Vec<Option<f64>>,
    #[serde(default)]
    pub theoretical_best_s: Option<f64>,
    #[serde(default)]
    pub total_cones: u32,
    #[serde(default)]
    pub total_off_course: u32,
    #[serde(default)]
    pub peak_speed_kph: f64,
    #[serde(default)]
    pub peak_rpm: f64,
    #[serde(default)]
    pub peak_lat_g: f64,
    #[serde(default)]
    pub peak_brake_g: f64,
    #[serde(default)]
    pub peak_accel_g: f64,
    #[serde(default)]
    pub avg_speed_mps: f64,
    #[serde(default)]
    pub full_throttle_frac: f64,
    #[serde(default)]
    pub braking_frac: f64,
    #[serde(default)]
    pub off_track_s: f64,
    #[serde(default)]
    pub ffb_clipped_frac: f64,
    /// Which vehicle model drove the run: 2 the validated bicycle, 3 the
    /// 4-wheel beta. Absent on runs from before simulator 0.7.2 (bicycle).
    #[serde(default)]
    pub vehicle_model: Option<u8>,
    /// Whether the run's times count: false if any lap was driven on a
    /// modified car or the run changed model part way. Absent before 0.7.2.
    #[serde(default)]
    pub counted: Option<bool>,
    /// The run-to-run setup the best lap was set on (legal setup items and
    /// the vehicle model, by parameter path). Absent before 0.7.2.
    #[serde(default)]
    pub setup: Option<std::collections::BTreeMap<String, f64>>,
    /// The physics revision of that model: the leaderboard era (simulator
    /// 0.7.4+). Absent before; Helios infers it from the version.
    #[serde(default)]
    pub physics_rev: Option<u32>,
}

/// One row of the Runs table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    /// The manifest format this run was written in.
    ///
    /// It matters because two derived numbers changed meaning at version 2.
    /// In version 1, `laps[].sectors` were CUMULATIVE splits with the final
    /// sector missing -- so `theoretical_best_s` is a sum of running totals,
    /// which on a real run came out half as fast again as a lap anybody
    /// drove -- and `best_lap_raw_s` was the quickest RAW lap, which is often
    /// a different lap from the best scored one. Both still parse, both still
    /// look like times, and both are wrong. `None` means a manifest so old it
    /// predates the field, which is treated as version 1.
    pub format_version: u32,
    /// The rate the log was actually achieved at, where the run recorded it.
    pub sample_rate_hz: Option<f64>,
    pub run_id: String,
    pub dir: String,
    pub telemetry_path: String,
    pub telemetry_bytes: u64,
    pub driver: String,
    pub driver_id: Option<String>,
    pub session: Option<String>,
    pub track: String,
    pub track_name: String,
    pub started_at: Option<String>,
    pub finished_reason: Option<String>,
    pub profile: Option<String>,
    /// See `Manifest::detected_input`. Observed, not declared.
    pub detected_input: Option<String>,
    pub device: Option<String>,
    pub physics: Option<String>,
    pub sim_version: Option<String>,
    pub synthetic: bool,
    pub samples: u64,
    pub assists: Assists,
    pub laps: Vec<Lap>,
    pub stats: Stats,
}

fn row_from(id: &str, dir: &Path, m: Manifest) -> RunRow {
    let telemetry = dir.join(TELEMETRY);
    let bytes = fs::metadata(&telemetry).map(|md| md.len()).unwrap_or(0);
    let track = m.track.unwrap_or_else(|| "unknown".into());
    let track_name = m.track_name.unwrap_or_else(|| track.clone());
    RunRow {
        format_version: m.format_version.unwrap_or(1),
        sample_rate_hz: m.sample_rate_actual_hz.or(m.sample_rate_hz),
        run_id: id.to_string(),
        dir: dir.display().to_string(),
        telemetry_path: telemetry.display().to_string(),
        telemetry_bytes: bytes,
        driver: m.driver.unwrap_or_else(|| "Unknown".into()),
        driver_id: m.driver_id,
        session: m.session,
        track,
        track_name,
        started_at: m.started_at,
        finished_reason: m.finished_reason,
        profile: m.profile_name.or(m.profile),
        detected_input: m.detected_input,
        device: m.device,
        physics: m.physics,
        sim_version: m.sim_version,
        synthetic: m.synthetic,
        samples: m.samples,
        assists: m.assists.unwrap_or_default(),
        // Before `laps` moves: the laps are read to class the run.
        stats: {
            let mut s = m.stats.unwrap_or_default();
            legacy_class(&mut s, m.counted, m.model_changes.as_deref(), m.car.as_ref());
            unvoid_off_laps(&mut s, m.counted, &m.laps);
            s
        },
        laps: m.laps,
    }
}

// ---------------------------------------------------------------- commands --

/// Where runs are being read from, so the UI can show it and a user can go
/// and look.
#[tauri::command]
pub fn sim_runs_dir() -> String {
    runs_root().display().to_string()
}

/// How many runs are on disk.
///
/// Counts directories rather than calling `sim_list_runs(None).len()`, which
/// reads and parses every manifest in the archive -- a season of them, on the
/// six-second poll the Sim tab runs while it is open.
pub fn run_count() -> usize {
    let Ok(entries) = fs::read_dir(runs_root()) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter(|e| e.file_name().to_str().map(is_safe_id).unwrap_or(false))
        .count()
}

/// Every run, newest first.
///
/// A directory that will not parse is skipped rather than failing the listing:
/// one half-written manifest from a rig that lost power must not take the
/// whole season's archive off the screen.
// `async`: this reads and parses every manifest in the archive, and a bare
// `#[tauri::command]` on a sync fn runs on the IPC thread.
#[tauri::command(async)]
pub fn sim_list_runs(limit: Option<usize>) -> Result<Vec<RunRow>, String> {
    let root = runs_root();
    let Ok(entries) = fs::read_dir(&root) else {
        // Nothing recorded yet is the normal state of a fresh machine.
        return Ok(Vec::new());
    };
    let mut ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| is_safe_id(n))
        .collect();
    // Run ids lead with a sortable timestamp, so newest-first is a reverse
    // lexical sort and costs no filesystem metadata calls.
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids.truncate(limit.unwrap_or(2000));

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let dir = root.join(&id);
        let Ok(text) = fs::read_to_string(dir.join(MANIFEST)) else { continue };
        match serde_json::from_str::<Manifest>(&text) {
            Ok(m) => out.push(row_from(&id, &dir, m)),
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// One run's whole manifest, verbatim, plus the paths.
///
/// Verbatim matters: the manifest carries the full vehicle setup the run was
/// driven with and every discrete event, and those are the fields that will
/// grow. Reserializing through the structs above would quietly drop whatever
/// this build does not yet know about.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run_id: String,
    pub dir: String,
    pub telemetry_path: String,
    pub telemetry_bytes: u64,
    /// The raw `run.json` text, parsed on the other side.
    pub manifest: String,
}

#[tauri::command]
pub fn sim_read_run(run_id: String) -> Result<RunDetail, String> {
    let dir = run_dir(&run_id)?;
    let manifest = fs::read_to_string(dir.join(MANIFEST))
        .map_err(|e| format!("read {}: {e}", dir.join(MANIFEST).display()))?;
    let telemetry = dir.join(TELEMETRY);
    let bytes = fs::metadata(&telemetry).map(|m| m.len()).unwrap_or(0);
    Ok(RunDetail {
        run_id,
        dir: dir.display().to_string(),
        telemetry_path: telemetry.display().to_string(),
        telemetry_bytes: bytes,
        manifest,
    })
}

/// The telemetry file for a run, for handing to the Logs module's CSV loader.
#[tauri::command]
pub fn sim_run_telemetry_path(run_id: String) -> Result<String, String> {
    let path = run_dir(&run_id)?.join(TELEMETRY);
    if !path.is_file() {
        return Err(format!("no telemetry in run {run_id}"));
    }
    Ok(path.display().to_string())
}

/// Nothing a simulator writes is this big. The cap is a guard against reading
/// a file somebody has put here by hand, not a real limit: a seven-minute
/// endurance run at 100 Hz is about 12 MB.
const MAX_TELEMETRY_BYTES: u64 = 256 * 1024 * 1024;

/// One run's telemetry, as text, for sharing it with the team.
///
/// The path alone is no use to the renderer -- it has no filesystem -- and
/// the sharing code needs the bytes to upload. Read here rather than handed
/// out as a path and opened by something else, so the same run-id guard
/// covers it as covers every other command in this file.
#[tauri::command(async)]
pub fn sim_read_telemetry(run_id: String) -> Result<String, String> {
    let path = run_dir(&run_id)?.join(TELEMETRY);
    let meta = fs::metadata(&path).map_err(|_| format!("no telemetry in run {run_id}"))?;
    if meta.len() > MAX_TELEMETRY_BYTES {
        return Err(format!("that telemetry is {} bytes, which is not a run", meta.len()));
    }
    fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

/// Write a run that came from somebody else into this machine's archive.
///
/// A shared run is a row in a table and an object in a bucket; the simulator
/// can only replay a DIRECTORY. This is the bridge: bring a teammate's lap
/// down and it becomes an ordinary run here, indistinguishable from one
/// driven at this rig, replayable and openable in Logs with no special case
/// anywhere downstream.
///
/// Refuses to overwrite. A run id is unique to the drive that made it, so an
/// id that already exists locally is either the same run -- nothing to do --
/// or a collision that should be looked at rather than silently resolved.
#[tauri::command(async)]
pub fn sim_import_run(run_id: String, manifest: String, telemetry: String) -> Result<String, String> {
    let dir = run_dir(&run_id)?;
    if dir.join(MANIFEST).is_file() {
        return Ok(dir.display().to_string());
    }
    // Parsed before anything is written: a manifest that will not load is a
    // run that would list as broken forever.
    serde_json::from_str::<Manifest>(&manifest)
        .map_err(|e| format!("that run's manifest will not parse: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Same write-then-rename as the simulator's own save, for the same
    // reason: a half-written run.json read by the six-second poll is a run
    // that vanishes from the list on the next refresh.
    for (name, body) in [(MANIFEST, manifest.as_str()), (TELEMETRY, telemetry.as_str())] {
        let tmp = dir.join(format!("{name}.tmp"));
        fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        fs::rename(&tmp, dir.join(name))
            .map_err(|e| format!("install {}: {e}", dir.join(name).display()))?;
    }
    Ok(dir.display().to_string())
}

/// Delete a run. Removes the whole directory, which is only ever the two files
/// the simulator wrote plus any stray `.tmp` from an interrupted save.
#[tauri::command]
pub fn sim_delete_run(run_id: String) -> Result<(), String> {
    let dir = run_dir(&run_id)?;
    // Refuse anything that is not recognisably a run: this is the one command
    // here that destroys something, and a caller that has somehow been handed
    // a wrong path should not be able to take a directory tree with it.
    if !dir.join(MANIFEST).is_file() {
        return Err(format!("{} is not a run directory", dir.display()));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("delete {}: {e}", dir.display()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_pre_0_7_2_four_wheel_run_is_classed_not_voided() {
        let mut st = Stats::default();
        let changes = vec![ModelChange { path: "vehicleModel".into() }];
        let car = serde_json::json!({ "vehicleModel": 3, "massKg": 267 });
        legacy_class(&mut st, Some(false), Some(&changes), Some(&car));
        assert_eq!(st.vehicle_model, Some(3));
        assert_eq!(st.counted, Some(true), "the model alone is a class, not a modification");
    }

    #[test]
    fn a_pre_0_7_2_modified_car_does_not_count() {
        let mut st = Stats::default();
        let changes = vec![ModelChange { path: "massKg".into() }];
        let car = serde_json::json!({ "vehicleModel": 2 });
        legacy_class(&mut st, Some(false), Some(&changes), Some(&car));
        assert_eq!(st.vehicle_model, Some(2));
        assert_eq!(st.counted, Some(false));
    }

    #[test]
    fn a_0_7_2_run_keeps_what_it_says() {
        let mut st = Stats { vehicle_model: Some(2), counted: Some(false), ..Default::default() };
        let car = serde_json::json!({ "vehicleModel": 3 });
        legacy_class(&mut st, Some(true), Some(&[]), Some(&car));
        assert_eq!(st.vehicle_model, Some(2));
        assert_eq!(st.counted, Some(false));
    }

    fn lap(valid: bool, counted: bool, vm: u8) -> Lap {
        serde_json::from_value(serde_json::json!({
            "lap": 1, "raw": 60.0, "total": 60.0, "valid": valid, "counted": counted, "vehicleModel": vm
        }))
        .unwrap()
    }

    #[test]
    fn an_untimed_sector_and_its_cones_survive_the_read() {
        let l: Lap = serde_json::from_value(serde_json::json!({
            "lap": 1, "raw": 60.0, "total": 62.0, "sectors": [20.1, null, 19.9], "sectorCones": [0, null, 1]
        }))
        .unwrap();
        assert_eq!(l.sectors, vec![Some(20.1), None, Some(19.9)]);
        assert_eq!(l.sector_cones, Some(vec![Some(0), None, Some(1)]));
        let back = serde_json::to_value(&l).unwrap();
        assert_eq!(back["sectorCones"], serde_json::json!([0, null, 1]), "and they are passed on");
    }

    #[test]
    fn an_off_course_lap_does_not_void_the_run() {
        let mut st = Stats { counted: Some(false), ..Default::default() };
        unvoid_off_laps(&mut st, Some(true), &[lap(true, true, 2), lap(false, false, 2)]);
        assert_eq!(st.counted, Some(true));
    }

    #[test]
    fn a_scored_lap_on_a_modified_car_still_voids_it() {
        let mut st = Stats { counted: Some(false), ..Default::default() };
        unvoid_off_laps(&mut st, Some(true), &[lap(true, false, 2), lap(false, false, 2)]);
        assert_eq!(st.counted, Some(false));
        let mut st = Stats { counted: Some(false), ..Default::default() };
        unvoid_off_laps(&mut st, Some(false), &[lap(true, true, 2)]);
        assert_eq!(st.counted, Some(false), "started on a modified car");
        let mut st = Stats { counted: Some(false), ..Default::default() };
        unvoid_off_laps(&mut st, Some(true), &[lap(true, true, 2), lap(true, true, 3)]);
        assert_eq!(st.counted, Some(false), "changed model part way");
    }

    #[test]
    fn a_very_old_run_says_nothing_and_stays_unclassed() {
        let mut st = Stats::default();
        legacy_class(&mut st, None, None, None);
        assert_eq!(st.vehicle_model, None);
        assert_eq!(st.counted, None);
    }

    use super::*;
    use std::sync::{Mutex, MutexGuard};

    fn write_run(root: &Path, id: &str, json: &str) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST), json).unwrap();
        fs::write(dir.join(TELEMETRY), "time_s,engine.rpm\n0,1000\n0.01,1100\n").unwrap();
    }

    fn manifest(driver: &str, track: &str, best: f64) -> String {
        format!(
            r#"{{"driver":"{driver}","track":"{track}","trackName":"T","startedAt":"2026-09-18T10:00:00Z",
                 "samples":100,"assists":{{"traction":true,"abs":false,"autoShift":false}},
                 "laps":[{{"lap":1,"raw":{best},"cones":1,"off":0,"total":{best},"sectors":[1.0,2.0],"startedAtS":0}}],
                 "stats":{{"durationS":10.0,"laps":1,"bestLapS":{best},"totalCones":1,"peakLatG":1.5}}}}"#
        )
    }

    /// Point the runs root at a scratch directory for the life of one test.
    ///
    /// The override is an environment variable, which is process-global, and
    /// Rust runs tests in parallel threads of one process -- so these tests
    /// have to take a lock or they overwrite each other's root and fail in
    /// whatever order the scheduler picks. The lock is held for the whole
    /// life of the guard, which is the whole life of the test.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct TempRoot {
        dir: PathBuf,
        _guard: MutexGuard<'static, ()>,
    }
    impl TempRoot {
        fn new(tag: &str) -> Self {
            // A panicking test poisons the lock; the root is replaced on the
            // way in regardless, so a poisoned lock is safe to take.
            let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!("helios-sim-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            std::env::set_var("HELIOS_SIM_RUNS_DIR", &dir);
            TempRoot { dir, _guard: guard }
        }
        fn path(&self) -> &Path { &self.dir }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            std::env::remove_var("HELIOS_SIM_RUNS_DIR");
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn ids_cannot_climb_out_of_the_runs_directory() {
        assert!(!is_safe_id(".."));
        assert!(!is_safe_id("../../Windows"));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id("a\\b"));
        assert!(!is_safe_id(".hidden"));
        assert!(!is_safe_id(""));
        assert!(is_safe_id("20260918-142233-autocross-9f3a"));
        assert!(run_dir("..").is_err());
        assert!(run_dir("x/y").is_err());
    }

    #[test]
    fn lists_newest_first_and_parses_the_manifest() {
        let root = TempRoot::new("list");
        write_run(root.path(), "20260101-100000-autocross-aaaa", &manifest("Alice", "autocross", 44.5));
        write_run(root.path(), "20260618-100000-endurance-bbbb", &manifest("Bob", "endurance", 90.0));
        let rows = sim_list_runs(None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].driver, "Bob", "newest run must come first");
        assert_eq!(rows[1].driver, "Alice");
        assert_eq!(rows[1].track, "autocross");
        assert_eq!(rows[1].stats.best_lap_s, Some(44.5));
        assert_eq!(rows[1].laps[0].sectors, vec![Some(1.0), Some(2.0)]);
        assert!(rows[1].assists.traction);
        assert!(!rows[1].assists.abs);
        assert!(rows[1].telemetry_bytes > 0);
    }

    #[test]
    fn a_broken_manifest_is_skipped_not_fatal() {
        let root = TempRoot::new("broken");
        write_run(root.path(), "20260101-100000-autocross-aaaa", &manifest("Alice", "autocross", 44.5));
        write_run(root.path(), "20260102-100000-autocross-bbbb", "{ this is not json");
        // A directory with no manifest at all, as an interrupted save leaves.
        fs::create_dir_all(root.path().join("20260103-100000-autocross-cccc")).unwrap();
        let rows = sim_list_runs(None).unwrap();
        assert_eq!(rows.len(), 1, "one good run must still list");
        assert_eq!(rows[0].driver, "Alice");
    }

    #[test]
    fn a_manifest_from_a_newer_sim_still_lists() {
        let root = TempRoot::new("newer");
        write_run(
            root.path(),
            "20260101-100000-autocross-aaaa",
            r#"{"driver":"Zoe","track":"autocross","somethingNew":{"a":[1,2,3]},
                "stats":{"bestLapS":40.0,"aBrandNewStat":7},"laps":[]}"#,
        );
        let rows = sim_list_runs(None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].driver, "Zoe");
        assert_eq!(rows[0].stats.best_lap_s, Some(40.0));
    }

    #[test]
    fn read_run_hands_back_the_manifest_verbatim() {
        let root = TempRoot::new("read");
        let json = manifest("Alice", "autocross", 44.5);
        write_run(root.path(), "20260101-100000-autocross-aaaa", &json);
        let d = sim_read_run("20260101-100000-autocross-aaaa".into()).unwrap();
        assert_eq!(d.manifest, json);
        assert!(d.telemetry_path.ends_with("telemetry.csv"));
        assert!(sim_read_run("nope".into()).is_err());
    }

    #[test]
    fn delete_only_removes_something_that_is_a_run() {
        let root = TempRoot::new("delete");
        write_run(root.path(), "20260101-100000-autocross-aaaa", &manifest("A", "autocross", 1.0));
        let stray = root.path().join("not-a-run");
        fs::create_dir_all(&stray).unwrap();
        fs::write(stray.join("important.txt"), "keep me").unwrap();

        assert!(sim_delete_run("not-a-run".into()).is_err());
        assert!(stray.join("important.txt").is_file(), "must not delete a non-run directory");

        sim_delete_run("20260101-100000-autocross-aaaa".into()).unwrap();
        assert!(sim_list_runs(None).unwrap().is_empty());
    }

    #[test]
    fn an_empty_archive_is_not_an_error() {
        let root = TempRoot::new("none");
        // A directory that does not exist at all, which is a fresh machine.
        let _ = fs::remove_dir_all(root.path());
        assert!(sim_list_runs(None).unwrap().is_empty());
    }
}
