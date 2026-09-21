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

/**
 * A course the simulator knows: one of the three fixed ones, or a
 * procedural course named by its event and seed -- `gen-ax-K7Q2`,
 * `gen-en-K7Q2`. The simulator builds the same course from the same seed on
 * every machine, so the id is the course.
 */
export type TrackId = "autocross" | "endurance" | "mis" | `gen-ax-${string}` | `gen-en-${string}`;

/** The two events a course can be generated for, as the simulator names them. */
export const GENERATED_EVENTS = [
  { event: "autocross", short: "ax", name: "Autocross", detail: "a new 0.8 km run from a seed" },
  { event: "endurance", short: "en", name: "Endurance", detail: "a new lapped course from a seed" },
] as const;
export type GeneratedEvent = (typeof GENERATED_EVENTS)[number]["event"];

// The seed rules are the simulator's (sim/src/track/generate.js) and have to
// stay so: a seed typed here must build the same course as one typed there.
const SEED_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

/** Canonical seed: upper case, letters/digits/dashes only, at most 12. */
export function normaliseSeed(s: string): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 12);
}

/** A fresh four-character seed. */
export function randomSeed(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += SEED_ALPHABET[Math.floor(rand() * SEED_ALPHABET.length)];
  return s;
}

/** `gen-ax-K7Q2` for an event and seed; an empty seed gets the simulator's default. */
export function generatedTrackId(event: GeneratedEvent, seed: string): TrackId {
  const ev = GENERATED_EVENTS.find((e) => e.event === event)!;
  return `gen-${ev.short}-${normaliseSeed(seed) || "SDM26"}` as TrackId;
}

/** `gen-en-abc` -> { event: "endurance", seed: "ABC" }; null for anything else. */
export function parseGeneratedId(id: string): { event: GeneratedEvent; seed: string } | null {
  const m = /^gen-(ax|en)-([A-Z0-9-]{1,12})$/i.exec(String(id ?? ""));
  if (!m) return null;
  return { event: m[1]!.toLowerCase() === "ax" ? "autocross" : "endurance", seed: normaliseSeed(m[2]!) };
}

/** Is this something the simulator can be asked to load? */
export function isTrackId(id: string): id is TrackId {
  return TRACKS.some((t) => t.id === id) || parseGeneratedId(id) !== null;
}

/**
 * When each fixed course last changed shape, as an instant.
 *
 * A lap time only means something against the course it was driven on. The
 * 2026 autocross and endurance courses gained their slaloms -- from the
 * published course maps -- in simulator 0.6.0, published 2026-09-20 at
 * 18:10 Arizona time (endurance: its third slalom in 0.6.1, 18:28); every
 * time set before that was driven without them,
 * and a board that mixed the two would rank a shortcut over a lap. So a run
 * on one of these courses that started before this instant is not ranked,
 * is not pushed to the team, and says why. The same goes for a run driven
 * later on a simulator older than 0.6.0, which is still the old course.
 */
export const COURSE_REVISED_AT: Record<string, { at: string; simVersion: string; why: string }> = {
  autocross: { at: "2026-09-21T01:10:00Z", simVersion: "0.6.0", why: "the course gained its slaloms" },
  // Endurance gained its third slalom in 0.6.1, published 18:28 the same day.
  endurance: { at: "2026-09-21T01:28:00Z", simVersion: "0.6.1", why: "the course gained its slaloms" },
};

/** `a` < `b` for dotted versions; a version that does not parse compares low. */
function versionLess(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0), pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * The newest simulator version that is known to have been released.
 *
 * Here to let `predatesCourse` ask whether a version string names a build that
 * has actually existed, because one of them did not: every run recorded before
 * 2026-09-19 09:55 UTC claims 1.0.0, a hand-written literal that never matched
 * the shipping build (0.2.0 at the time). See the simulator's commit "Every
 * run ever recorded claims a version that has never existed".
 *
 * Going stale is SAFE and needs no discipline to maintain. A run claiming a
 * version newer than this is simply judged on its date instead, and a genuinely
 * newer build's runs are dated after every revision, so they rank either way.
 * What the constant buys is the other direction: an impossibly HIGH version on
 * an old run stops being taken at its word.
 */
export const NEWEST_KNOWN_SIM_VERSION = "0.6.6";

/**
 * Was this run driven on a course that has since changed shape? See
 * `COURSE_REVISED_AT`.
 *
 * The simulator version decides it, when the version can be believed. That
 * qualification is the whole of this function's history: the rule used to
 * trust the field unconditionally, which made it exactly as trustworthy as the
 * field, and the field was a lie. Twenty-five runs driven two days before the
 * autocross slaloms existed carry `1.0.0` -- above the 0.6.0 revision, so they
 * were waved through -- and the quickest, a 38.9 through open road where the
 * board's real times run 42+, sat on top of the leaderboard.
 *
 * So a version is believed only if it names a build that has plausibly shipped
 * (see `NEWEST_KNOWN_SIM_VERSION`). Otherwise the run is judged on when it was
 * driven, which is what the rule already did for rows carrying no version.
 *
 * NOT a blacklist of "1.0.0". The simulator will reach 1.0.0 honestly and
 * those runs must rank; they will, because their dates fall after every
 * revision. What condemns these is the date, not the string.
 *
 * And deliberately NOT "an old date is enough on its own". A build is often
 * driven before it is published -- the 0.6.2 runs on the board were set
 * 47 minutes after 0.6.0 went up -- so a date-first rule would condemn a
 * maintainer's own laps on a build that had the current course all along.
 */
export function predatesCourse(run: Pick<SimRun, "track" | "startedAt" | "simVersion">): boolean {
  const rev = COURSE_REVISED_AT[run.track];
  if (!rev) return false;

  const v = run.simVersion?.replace(/^fsae-sim\s+/, "").trim();
  // `versionLess(NEWEST, v)` rather than `!versionLess(v, NEWEST)`: a version
  // EQUAL to the newest known one is believable, and is the common case.
  const believable = !!v && /^\d+\.\d+/.test(v) && !versionLess(NEWEST_KNOWN_SIM_VERSION, v);
  if (believable) return versionLess(v!, rev.simVersion);

  if (!run.startedAt) return true; // no date at all: it cannot be placed after the change
  const t = Date.parse(run.startedAt);
  return Number.isNaN(t) || t < Date.parse(rev.at);
}

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
  /** Sector durations. `null` for a sector that was never timed -- the car's
   *  course distance jumped over the boundary -- and the split after such a
   *  gap spans two sectors, so it is not a sector time either. */
  sectors: (number | null)[];
  /**
   * Cones struck in each sector, same length and index as `sectors`. Written
   * from manifest format 4 (`SECTOR_CONES_FORMAT_VERSION`); absent before it,
   * when a lap's cones cannot be attributed to a sector at all.
   */
  sectorCones?: (number | null)[];
  startedAtS: number;
}

/**
 * The manifest format at which each lap says which sector its cones were in
 * (`laps[].sectorCones`). Before it, a lap with any cone on it cannot hold a
 * sector record: the two seconds belong to some sector and nobody can say which.
 */
export const SECTOR_CONES_FORMAT_VERSION = 4;

/** Seconds a struck cone adds, as FSAE scores it. */
export const CONE_PENALTY_S = 2;

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
  /** When the team's storage budget removed this run's lap on purpose; null
   *  when it did not. Such a lap is not put back by any client. */
  telemetryEvictedAt?: string | null;
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
  /** Replay only, 1-based: the lap of the `replay` run to open on. */
  replayLap?: number;
  /** Replay only, 1-based: the lap of the `ghost` run to line up against. */
  ghostLap?: number;
  /** Replay only, 1-based: start at this sector's entry on `replayLap`, with
   *  a short lead-in, the ghost synced at the same sector entry. */
  sector?: number;
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

/** Every platform the feed has a build for, sorted, so a machine the feed has
 *  nothing for can be told that rather than "not installed". */
export function simFeedPlatforms(): Promise<string[]> {
  return invoke<string[]>("sim_feed_platforms");
}

/** The platform Helios is running on, in the feed's own words. */
export function thisPlatform(): "windows" | "macos" | "linux" {
  const p = typeof navigator === "undefined" ? "" : navigator.platform ?? "";
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "";
  if (/^Win/i.test(p) || /Windows/i.test(ua)) return "windows";
  if (/^Mac/i.test(p) || /Mac OS|Macintosh/i.test(ua)) return "macos";
  return "linux";
}

export const PLATFORM_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

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
  const fixed = TRACKS.find((t) => t.id === id);
  if (fixed) return fixed.name;
  const g = parseGeneratedId(id);
  if (g) return `${GENERATED_EVENTS.find((e) => e.event === g.event)!.name} ${g.seed}`;
  return id;
}

/** The scored time for a run: its best lap, or nothing if it never set one. */
export function runBest(run: SimRun): number | null {
  return run.stats.bestLapS ?? null;
}

/**
 * Is there telemetry to open, wherever it lives?
 *
 * Locally that is a file with bytes in it -- a run whose telemetry never
 * landed has a path and zero bytes. For a shared run it is whether the driver
 * uploaded the lap at all, which only happens for a personal best: everything
 * else shares its time and nothing more.
 *
 * One definition, for the runs table and the detail panel both. They used to
 * disagree about the same run on the same screen: the table offered to fetch
 * and open a teammate's lap while the panel beside it said the run had no
 * telemetry file, because the panel was reading the local byte count of a run
 * that has no local file.
 */
export function hasTelemetry(run: SimRun): boolean {
  return run.remote ? !!run.telemetryObject : run.telemetryBytes > 0;
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
    // A time on a course that has since changed shape. See `COURSE_REVISED_AT`.
    !predatesCourse(run) &&
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
  if ((run.stats.laps ?? 0) === 0) return "no completed lap";
  // Before the time is looked at, not after. A run whose only lap went off
  // has had no time BY CONSTRUCTION since format 3, so asking "is there a
  // time" first answered "no completed lap" -- the one thing definitely not
  // true of it: the lap was completed, and thrown out. Three real runs sat
  // in the archive saying that. "Off course" is the simulator's own word for
  // it, on its finish card and in its lap list, so it is the word here.
  if (bestLapWentOffCourse(run)) return "that lap went off course";
  if (runBest(run) == null) return "no completed lap";
  if (predatesCourse(run)) {
    const rev = COURSE_REVISED_AT[run.track]!;
    return `driven before ${rev.why} (simulator ${rev.simVersion}), so it does not compare`;
  }
  const on: string[] = [];
  if (run.assists.traction) on.push("traction control");
  if (run.assists.abs) on.push("ABS");
  if (run.assists.autoShift) on.push("automatic gearbox");
  return on.length ? `${on.join(", ")} was on` : null;
}
