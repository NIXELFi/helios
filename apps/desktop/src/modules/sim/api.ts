/* Data layer for the Sim module.
 *
 * Every call here is one Tauri command in `src-tauri/src/sim/`. The module is
 * a reader: the simulator writes run directories, Helios lists and opens them,
 * and the only thing Helios writes is the remembered path to the executable.
 *
 * Nothing in here touches Supabase. A run is a file on disk, which is what
 * makes the archive work on a rig with no network and on a shared drive with
 * no server.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type TrackId = "autocross" | "endurance" | "mis";

export interface SimAssists {
  traction: boolean;
  abs: boolean;
  autoShift: boolean;
}

export interface SimLap {
  lap: number;
  /** Lap time before penalties. */
  raw: number;
  cones: number;
  off: number;
  /** Lap time with this lap's penalties added — the scored time. */
  total: number;
  /** Did this lap score a time? False when it left the course, which does not
   *  score here. Absent on a manifest written before the rule, where every
   *  completed lap scored — so read it as `!== false`, never as truthy. */
  valid?: boolean;
  sectors: number[];
  startedAtS: number;
}

/**
 * The manifest format at which the derived lap numbers became trustworthy.
 *
 * Before version 2 the simulator wrote `laps[].sectors` as cumulative splits
 * and omitted the final sector, so `theoreticalBestS` is the sum of a set of
 * running totals -- a number that is not a lap time and, on every real run in
 * the archive, is slower than laps that were actually driven. `bestLapRawS`
 * was the quickest RAW lap rather than the raw time of the best SCORED one, so
 * "Best" minus "Raw" reads as a penalty that was never applied.
 *
 * Nothing about either field looks wrong at a glance, which is the problem.
 * The UI hides them for older runs rather than drawing them.
 */
export const SECTOR_FORMAT_VERSION = 2;

/**
 * The version at which a lap that left the course stopped having a time.
 *
 * Before version 3 an off course was scored as +10 s and the lap stood, so a
 * version 2 run's best lap and sector bests may both be times that went off.
 * They look like ordinary times with a plausible number added, which is
 * exactly why the version has to be consulted rather than the numbers.
 */
export const OFF_COURSE_FORMAT_VERSION = 3;

/**
 * Can this run's theoretical best and raw-lap columns be believed?
 *
 * Two separate ways they can be wrong. Version 1 wrote cumulative splits with
 * the last one missing, so nothing about its sectors is a sector time.
 * Version 2 wrote real sector times but folded in sectors from laps that left
 * the course, so a theoretical best can be made of pieces nobody drove
 * legally -- only a problem for a run that actually went off, which is why
 * this asks rather than refusing every version 2 run outright.
 */
export function hasTrustworthySectors(
  run: Pick<SimRun, "formatVersion"> & { stats?: Pick<SimStats, "totalOffCourse"> },
): boolean {
  const v = run.formatVersion ?? 1;
  if (v >= OFF_COURSE_FORMAT_VERSION) return true;
  if (v < SECTOR_FORMAT_VERSION) return false;
  return (run.stats?.totalOffCourse ?? 0) === 0;
}

/**
 * Did the lap this run would rank on leave the course?
 *
 * An off course does not score a time here -- stricter than FSAE, which adds
 * 20 s and keeps it, and deliberately so: this is a board people practise
 * against with nobody marshalling it, and a lap that cut the course is not
 * comparable with one that did not.
 *
 * The simulator stopped filing such laps as times at version 3, so for a new
 * run this is already true by construction and this is the backstop for the
 * archive recorded before it. Per lap rather than per run, because on
 * endurance one excursion should not throw away the clean laps around it.
 */
export function bestLapWentOffCourse(run: SimRun): boolean {
  const n = run.stats.bestLapNumber;
  const lap = n != null ? run.laps?.find((l) => l.lap === n) : undefined;
  if (lap) return (lap.off ?? 0) > 0;
  // No per-lap detail to consult: an older manifest, or a shared row that
  // carried none. Fall back to the run, which is exact on autocross -- one
  // lap -- and cautious on endurance, which is the right way to be wrong.
  return (run.stats.totalOffCourse ?? 0) > 0;
}

export interface SimStats {
  durationS: number;
  distanceM: number;
  laps: number;
  bestLapS: number | null;
  /** The raw time OF the best scored lap -- not the quickest raw lap in the
   *  run, which may be a different lap with more cones on it. */
  bestLapRawS: number | null;
  bestLapNumber: number | null;
  /** Cones on the best scored lap. Optional: runs recorded before this was
   *  added do not carry it. */
  bestLapCones?: number | null;
  /** The outright quickest lap, penalties ignored. */
  fastestRawLapS?: number | null;
  fastestRawLapNumber?: number | null;
  bestSectors: (number | null)[];
  theoreticalBestS: number | null;
  totalCones: number;
  totalOffCourse: number;
  peakSpeedKph: number;
  peakRpm: number;
  peakLatG: number;
  peakBrakeG: number;
  peakAccelG: number;
  avgSpeedMps: number;
  fullThrottleFrac: number;
  brakingFrac: number;
  offTrackS: number;
  ffbClippedFrac: number;
}

export interface SimRun {
  /** Which manifest format this run was written in; see
   *  `hasTrustworthySectors`. Older runs report 1. */
  formatVersion: number;
  /** The rate the log was actually achieved at, where the run recorded it.
   *  Null on a run from a simulator that predates the field. */
  sampleRateHz: number | null;
  runId: string;
  dir: string;
  telemetryPath: string;
  telemetryBytes: number;
  driver: string;
  /** The Helios account that launched the run, when Helios launched it.
   *  Null for a run started by opening the simulator directly. */
  driverId: string | null;
  session: string | null;
  track: string;
  trackName: string;
  startedAt: string | null;
  finishedReason: string | null;
  profile: string | null;
  /**
   * What the simulator OBSERVED steering the car: "wheel", "controller" or
   * "keyboard". `profile` beside it is the dropdown the driver picked. See
   * `deviceClass`, which prefers this one and says why.
   *
   * Null on a run recorded before the simulator measured it.
   */
  detectedInput: string | null;
  device: string | null;
  physics: string | null;
  simVersion: string | null;
  /** True for a run produced by the robot driver rather than a person. */
  synthetic: boolean;
  samples: number;
  assists: SimAssists;
  laps: SimLap[];
  stats: SimStats;

  // ---- shared runs ----
  // A run from the team's archive rather than this machine's disk. It has no
  // files here, so `dir` and `telemetryPath` are empty and anything that
  // wants to open one locally has to say so. See `lib/share.ts`.
  /** True when this came from `sim.runs` rather than from a directory. */
  remote?: boolean;
  /** The Helios account that shared it, as Helios knows them. */
  sharedBy?: string | null;
  subteam?: string | null;
  /** Key in the `sim-telemetry` bucket, when the driver shared the lap
   *  itself and not only its time. Null for most runs by design. */
  telemetryObject?: string | null;
  telemetrySharedBytes?: number;
}

export interface SimStatus {
  exePath: string | null;
  exeConfigured: boolean;
  version: string | null;
  runsDir: string;
  runCount: number;
  searched: string[];
}

/** A discrete thing that happened during a run. */
export interface SimEvent {
  t: number;
  kind: string;
  [key: string]: unknown;
}

/** The whole `run.json`, including the fields the listing does not carry. */
export interface SimManifest extends Omit<SimRun, "dir" | "telemetryPath" | "telemetryBytes"> {
  /** What the sampler was ASKED for. `sampleRateHz` on `SimRun` is what it
   *  achieved, which is lower on a machine that cannot hold the frame rate. */
  sampleRateTargetHz?: number;
  /** What the live delta was measured against while the run was driven. */
  reference?: { lapS: number | null; label: string | null; source: string | null } | null;
  trackLengthM?: number;
  trackClosed?: boolean;
  trackSectors?: number[];
  trackSource?: string | null;
  endedAt?: string;
  channels?: string[];
  derivedChannels?: Record<string, string>;
  events?: SimEvent[];
  /** Every live vehicle parameter as the run was driven with it. */
  setup?: Record<string, number>;
  datum?: { lat: number; lon: number; bearingDeg: number; name: string };
  truncated?: boolean;
}

export interface SimRunDetail {
  runId: string;
  dir: string;
  telemetryPath: string;
  telemetryBytes: number;
  manifest: SimManifest;
}

export interface LaunchRequest {
  track?: TrackId;
  profile?: string;
  driver?: string;
  driverId?: string;
  session?: string;
  traction?: boolean;
  abs?: boolean;
  autoShift?: boolean;
  autostart?: boolean;
  windowed?: boolean;
  noRecord?: boolean;
  replay?: string;
  ghost?: string;
  /** A recorded run whose best lap the live delta counts against. */
  reference?: string;
}

export interface LaunchResult {
  exePath: string;
  args: string[];
  pid: number;
}

export function simStatus(): Promise<SimStatus> {
  return invoke<SimStatus>("sim_status");
}

export function simSetExePath(path: string | null): Promise<SimStatus> {
  return invoke<SimStatus>("sim_set_exe_path", { path });
}

export function simListRuns(limit?: number): Promise<SimRun[]> {
  return invoke<SimRun[]>("sim_list_runs", { limit: limit ?? null });
}

export async function simReadRun(runId: string): Promise<SimRunDetail> {
  const raw = await invoke<{
    runId: string; dir: string; telemetryPath: string; telemetryBytes: number; manifest: string;
  }>("sim_read_run", { runId });
  return { ...raw, manifest: JSON.parse(raw.manifest) as SimManifest };
}

export function simTelemetryPath(runId: string): Promise<string> {
  return invoke<string>("sim_run_telemetry_path", { runId });
}

export function simDeleteRun(runId: string): Promise<void> {
  return invoke<void>("sim_delete_run", { runId });
}

/** One local run's telemetry as text, for sharing it. */
export function readRunTelemetry(runId: string): Promise<string | null> {
  return invoke<string>("sim_read_telemetry", { runId }).catch(() => null);
}

/**
 * Write a teammate's run into this machine's archive.
 *
 * A shared run is a row and a storage object; the simulator can only replay a
 * directory. After this it is an ordinary local run -- replayable, openable
 * in Logs, indistinguishable from one driven here.
 */
export function simImportRun(
  runId: string,
  manifest: SimManifest,
  telemetry: string,
): Promise<string> {
  return invoke<string>("sim_import_run", {
    runId,
    manifest: JSON.stringify(manifest),
    telemetry,
  });
}

export function simLaunch(request: LaunchRequest): Promise<LaunchResult> {
  return invoke<LaunchResult>("sim_launch", { request });
}

export function simRunsDir(): Promise<string> {
  return invoke<string>("sim_runs_dir");
}

/** A downloadable simulator build, from the team's build feed. */
export interface SimBuild {
  version: string;
  platform: string;
  url: string;
  sha256: string;
  bytes: number;
  notes: string | null;
  published: string | null;
}

export interface SimInstalled {
  version: string;
  exePath: string;
  bytes: number;
}

/** What the feed offers for this machine, or null. Throws when the feed is
 *  unreachable, which for a rig at a test day is a normal thing to be. */
export function simAvailableBuild(): Promise<SimBuild | null> {
  return invoke<SimBuild | null>("sim_available_build");
}

/**
 * Download, verify and install the build the feed names.
 *
 * Takes only a version: the backend re-fetches the feed and installs what IT
 * names. Passing the url and hash from here would make the checksum prove
 * nothing, because this side would be supplying both halves of the comparison.
 */
/** How far a download has got. See `onSimInstallProgress`. */
export interface SimInstallProgress {
  version: string;
  bytes: number;
  /** What the feed said the whole thing is, or 0 when it did not say. */
  total: number;
}

/**
 * Watch a download.
 *
 * The executable is small today and will not always be, and a button that
 * says "Downloading…" and nothing else for a minute is indistinguishable from
 * one that has hung. Returns an unsubscribe.
 */
export function onSimInstallProgress(cb: (p: SimInstallProgress) => void): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<SimInstallProgress>("sim://install-progress", (e) => cb(e.payload)).then((fn) => {
    if (cancelled) fn();
    else off = fn;
  });
  return () => { cancelled = true; off?.(); };
}

export function simInstall(version: string): Promise<SimInstalled> {
  return invoke<SimInstalled>("sim_install", { version });
}


// ------------------------------------------------------------------ format --

/** Lap and sector times, the way a timing screen writes them. */
export function fmtTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0
    ? `${sign}${m}:${rest.toFixed(3).padStart(6, "0")}`
    : `${sign}${rest.toFixed(3)}`;
}

/** A gap, always signed, so "quicker" and "slower" are never ambiguous. */
export function fmtGap(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return `${seconds >= 0 ? "+" : "−"}${Math.abs(seconds).toFixed(3)}`;
}

export function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export const TRACKS: { id: TrackId; name: string; detail: string }[] = [
  { id: "autocross", name: "Autocross 2026", detail: "685 m, single timed run" },
  { id: "endurance", name: "Endurance 2026", detail: "2.12 km, lapped" },
  { id: "mis", name: "Michigan International Speedway", detail: "venue, free roam" },
];

export const PROFILES: { id: string; name: string }[] = [
  { id: "wheel", name: "Steering wheel" },
  { id: "gamepad-xbox", name: "Xbox controller" },
  { id: "gamepad-ps", name: "PlayStation controller" },
  { id: "keyboard", name: "Keyboard and mouse" },
];

/**
 * What was used to drive it.
 *
 * Three classes, not four: an Xbox pad and a PlayStation pad are the same
 * instrument. Boards are compared within a class because they are not
 * comparable across one -- a wheel has a real stop at a real angle and
 * two hundred times the resolution, and a keyboard is a switch that software
 * ramps into a steering command. Putting them on one list does not rank
 * drivers, it ranks hardware.
 *
 * `unknown` for a run whose manifest predates the field, or one recorded with
 * a profile this build has never heard of. It is a class of its own rather
 * than being quietly folded into one of the others.
 */
export type DeviceClass = "wheel" | "controller" | "keyboard" | "unknown";

/**
 * Which board a run belongs on.
 *
 * `detectedInput` FIRST, and `profile` only as a fallback, because the profile
 * is a dropdown. The controller profile reads an axis and a wheel base has
 * axes, so "pick Controller, steer the wheel anyway" would have handed the
 * controller record to whoever owned a wheel and thought about it for a
 * minute. `detectedInput` is written by the branch of the simulator's input
 * loop that actually produced the steering command each frame, and it asks the
 * device -- a base the rig opened for force feedback, or a vendor string that
 * names a wheel -- rather than the profile.
 *
 * That is not tamper proof. The manifest is a JSON file on the driver's own
 * machine and a determined person can edit it; a leaderboard for a student
 * team is not worth cryptography. It closes the free cheat, which is the one
 * that would actually get used.
 *
 * Runs recorded before the simulator measured this still fall back to the
 * profile, which is all anybody ever had for them.
 */
export function deviceClass(run: Pick<SimRun, "profile" | "detectedInput">): DeviceClass {
  const d = (run.detectedInput ?? "").toLowerCase();
  if (d === "wheel" || d === "controller" || d === "keyboard") return d;
  const p = (run.profile ?? "").toLowerCase();
  if (!p) return "unknown";
  if (p === "wheel" || p.includes("wheel")) return "wheel";
  if (p.startsWith("gamepad") || p.includes("controller") || p.includes("pad")) return "controller";
  if (p === "keyboard" || p.includes("keyboard") || p.includes("mouse")) return "keyboard";
  return "unknown";
}

export const DEVICE_CLASSES: { id: DeviceClass; name: string; short: string }[] = [
  { id: "wheel", name: "Wheel and pedals", short: "Wheel" },
  { id: "controller", name: "Controller", short: "Pad" },
  { id: "keyboard", name: "Keyboard and mouse", short: "M&K" },
  { id: "unknown", name: "Unrecorded device", short: "?" },
];

export function trackName(id: string): string {
  return TRACKS.find((t) => t.id === id)?.name ?? id;
}

/** The scored time for a run: its best lap, or nothing if it never set one. */
export function runBest(run: SimRun): number | null {
  return run.stats.bestLapS ?? null;
}

/**
 * A run counts toward a leaderboard only if a person drove it clean of the
 * things that make a time meaningless to compare: the driver aids, and the
 * robot driver that the sample generator uses.
 *
 * Runs that fail this are still listed and still replayable — they are simply
 * not ranked against runs that did not have help.
 */
export function isRankable(run: SimRun): boolean {
  return (
    !run.synthetic &&
    // A lap time is a claim about a person, so it has to be attributable to
    // one. Helios only launches for a signed-in account and stamps its id into
    // the run; a run with no id came from somebody opening the simulator and
    // typing a name, which is not the same thing and does not go on a board.
    !!run.driverId &&
    runBest(run) != null &&
    // Stricter than FSAE, on purpose. See `bestLapWentOffCourse`.
    !bestLapWentOffCourse(run) &&
    !run.assists.traction &&
    !run.assists.abs &&
    !run.assists.autoShift
  );
}

/** Why a run is not on the leaderboard, for a tooltip. */
export function unrankedReason(run: SimRun): string | null {
  if (isRankable(run)) return null;
  if (run.synthetic) return "driven by the robot driver, not a person";
  if (!run.driverId) return "not launched from Helios, so the driver is unverified";
  if (runBest(run) == null) return "no completed lap";
  if (bestLapWentOffCourse(run)) return "that lap left the course";
  const on: string[] = [];
  if (run.assists.traction) on.push("traction control");
  if (run.assists.abs) on.push("ABS");
  if (run.assists.autoShift) on.push("automatic gearbox");
  return on.length ? `${on.join(", ")} was on` : null;
}
