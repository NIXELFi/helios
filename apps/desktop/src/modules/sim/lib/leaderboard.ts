/* Turning a pile of runs into the numbers a race team argues about.
 *
 * All pure functions over the run listing, so every one of them is testable
 * without a filesystem, a simulator or a window.
 *
 * The thing worth being careful about is which time counts. A lap has a raw
 * time and a scored total -- raw plus two seconds a cone -- and the scored
 * total is the one that matters. A lap that went off course has no scored
 * total at all: FSAE would add twenty seconds and keep the time, and this
 * board deliberately does not, because nobody is marshalling it (see
 * `bestLapWentOffCourse`). `stats.bestLapS` is already the scored total, so
 * that is what ranks. Raw is carried alongside because it is what tells a
 * driver whether they were quick and untidy or just slow.
 */

import {
  CONE_PENALTY_S, DEVICE_CLASSES, GENERATED_EVENTS, VEHICLE_MODELS, deviceClass, hasTelemetry, hasTrustworthySectors,
  isRankable, modelEraKey, parseGeneratedId, physicsEraOf, runBest, trackName, vehicleModelOf,
  type DeviceClass, type SimLap, type SimRun, type VehicleModel,
} from "../api";

/**
 * One sector time, and exactly where it was driven.
 *
 * The time is the SCORED one: the sector as driven plus two seconds for every
 * cone struck inside it. A sector record is a claim that this piece of the
 * course can be driven this quickly, and a run that ploughed through the
 * slalom has not made that claim -- it has made a much slower one. Raw is
 * carried beside it for the same reason the lap board carries it: it is what
 * tells a driver whether they were quick and untidy or just slow.
 *
 * The source is kept so the time can be watched, not only read: which run,
 * which lap, and whether the lap itself is still anywhere to be watched.
 */
export interface SectorTime {
  /** Scored: `rawTime + CONE_PENALTY_S * cones`. What ranks. */
  time: number;
  rawTime: number;
  cones: number;
  runId: string;
  /** Display name on that run. */
  driver: string;
  /** The Helios account. Ranked runs always have one. */
  driverId: string;
  /** The lap number in that run (`laps[].lap`, 1-based), or null when the
   *  time came from the run's summary rather than from a lap. */
  lap: number | null;
  /** When the run started; the older of two equal times holds the record. */
  startedAt: string | null;
  /** A teammate's shared run rather than one on this disk. */
  remote: boolean;
  /** Whether that lap can still be watched. See `hasTelemetry`. */
  hasTelemetry: boolean;
  /** The team's storage budget removed that lap on purpose. */
  evicted: boolean;
}

/** A sector as one lap drove it, before it knows whose it is. */
interface SectorPiece { time: number; rawTime: number; cones: number }

/**
 * The sector times one lap can put forward, index for index; null where a
 * sector cannot count.
 *
 * Every exclusion here is one the simulator's own fold already makes or one
 * the cones force:
 * - a lap that did not score (left the course) contributes nothing;
 * - a sector never timed is null, and so is the one after it, whose clock
 *   started at the last boundary crossed and so spans two sectors;
 * - from format 4 each sector carries its own cones and is penalised by
 *   them; an unknown count for a sector means that sector cannot count;
 * - before format 4 a lap's cones cannot be placed, so a lap with ANY cone
 *   contributes nothing at all -- the alternative is guessing which sector
 *   the two seconds belong to, and the guess that flatters is always "none".
 */
export function lapSectorPieces(lap: SimLap): (SectorPiece | null)[] {
  if (lap.valid === false || (lap.off ?? 0) > 0) return [];
  const sectors = Array.isArray(lap.sectors) ? lap.sectors : [];
  const perSector = Array.isArray(lap.sectorCones) && lap.sectorCones.length >= sectors.length
    ? lap.sectorCones
    : null;
  // No per-sector cones: the whole lap is clean or it is nothing.
  if (!perSector && (lap.cones ?? 0) !== 0) return [];
  const out: (SectorPiece | null)[] = [];
  for (let i = 0; i < sectors.length; i++) {
    const raw = sectors[i];
    const prevUntimed = i > 0 && (sectors[i - 1] == null || !Number.isFinite(sectors[i - 1]!));
    const cones = perSector ? perSector[i] : 0;
    if (raw == null || !Number.isFinite(raw) || prevUntimed || cones == null || !Number.isFinite(cones) || cones < 0) {
      out.push(null);
      continue;
    }
    out.push({ time: raw + CONE_PENALTY_S * cones, rawTime: raw, cones });
  }
  return out;
}

/** Stamp a piece with the run and lap it came from. */
function sourced(run: SimRun, lap: number | null, p: SectorPiece): SectorTime {
  return {
    ...p,
    runId: run.runId,
    driver: run.driver,
    driverId: run.driverId ?? "",
    lap,
    startedAt: run.startedAt,
    remote: !!run.remote,
    hasTelemetry: hasTelemetry(run),
    evicted: !!run.telemetryEvictedAt,
  };
}

/**
 * Does `a` beat `b`? Lower scored time; on a dead heat the one set FIRST
 * holds it, as a record does; then run id and lap, which are arbitrary but
 * fixed, so the answer never depends on the order the listing arrived in.
 */
export function sectorBeats(a: SectorTime, b: SectorTime | null | undefined): boolean {
  if (!b) return true;
  if (a.time !== b.time) return a.time < b.time;
  const sa = a.startedAt ?? "￿", sb = b.startedAt ?? "￿";
  if (sa !== sb) return sa < sb;
  if (a.runId !== b.runId) return a.runId < b.runId;
  return (a.lap ?? Infinity) < (b.lap ?? Infinity);
}

/**
 * The best time this run drove each sector, and on which lap.
 *
 * From the laps, not from `stats.bestSectors`: the summary was folded by the
 * simulator without penalties, so on any run older than format 4 it can hold
 * a sector somebody drove straight through a cone. Only when the run carries
 * no laps at all is the summary used, and then only if the run struck no
 * cones anywhere -- the one case where it cannot be flattering.
 */
export function runBestSectors(run: SimRun): (SectorTime | null)[] {
  if (!hasTrustworthySectors(run)) return [];
  const out: (SectorTime | null)[] = [];
  const laps = Array.isArray(run.laps) ? run.laps : [];
  if (laps.length) {
    for (const lap of laps) {
      const pieces = lapSectorPieces(lap);
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (!p) { if (out[i] === undefined) out[i] = null; continue; }
        const t = sourced(run, lap.lap ?? null, p);
        if (sectorBeats(t, out[i])) out[i] = t;
      }
    }
    return out;
  }
  if ((run.stats.totalCones ?? 0) !== 0) return [];
  const summary = run.stats.bestSectors ?? [];
  for (let i = 0; i < summary.length; i++) {
    const s = summary[i];
    out.push(s == null || !Number.isFinite(s) ? null : sourced(run, null, { time: s, rawTime: s, cones: 0 }));
  }
  return out;
}

/** Fold `next` into `into`, index by index, keeping the better of each. */
function foldSectors(into: (SectorTime | null)[], next: (SectorTime | null)[]): void {
  for (let i = 0; i < next.length; i++) {
    const n = next[i] ?? null;
    if (n && sectorBeats(n, into[i])) into[i] = n;
    else if (into[i] === undefined) into[i] = null;
  }
}

export interface DriverEntry {
  /** The Helios account. `isRankable` guarantees it exists. */
  driverId: string;
  /** Their display name as of their most recent ranked run. */
  driver: string;
  /** Best scored lap on this course. */
  best: number;
  /** That same lap's time before penalties, so Best minus this is what the
   *  cones cost. It comes from the run's `bestLapRawS`, which is the raw time
   *  of the best SCORED lap -- not the run's quickest raw lap. */
  bestRaw: number | null;
  /** The run that best lap came from. */
  runId: string;
  when: string | null;
  cones: number;
  /**
   * The newest run seen for this driver, which is NOT `when`.
   *
   * `when` is the date of their best lap. Using it to decide whether a run
   * carries the newest display name only worked because `sim_list_runs`
   * happens to return newest-first; sort the input any other way and the
   * board shows a name the driver changed months ago. Tracked separately so
   * the answer does not depend on the order it was asked in.
   */
  seenTo: string | null;
  /** How many ranked runs this driver has on the course. */
  runs: number;
  /** Gap to the leader, 0 for the leader. */
  gap: number;
  rank: number;
  /** Their own best each sector, across every ranked run on the course,
   *  penalised for its cones, with the run and lap it came from. */
  bestSectors: (SectorTime | null)[];
  /** The lap number of their best lap within `runId`, when the run says. */
  bestLap: number | null;
  /** Those sectors added up: the lap they have already driven in pieces. */
  theoretical: number | null;
  /** The run-to-run setup their best lap was set on (simulator 0.7.2+);
   *  null for older runs, which did not record it. */
  setup: Record<string, number> | null;
}

export interface TrackBoard {
  track: string;
  trackName: string;
  entries: DriverEntry[];
  /** The quickest each sector has been driven by anyone, cones included,
   *  and where. */
  sectorRecords: (SectorTime | null)[];
  /** Those added up: the lap the team has driven in pieces but never in one. */
  teamTheoretical: number | null;
  /** Ranked runs on this course. */
  runCount: number;
  /** Runs on this course that exist but are not ranked. */
  unrankedCount: number;
}

function minDefined(a: number | null, b: number | null | undefined): number | null {
  if (b == null || !Number.isFinite(b)) return a;
  if (a == null) return b;
  return Math.min(a, b);
}

/**
 * One board per course, each ranking drivers by their best scored lap.
 *
 * A driver's sector bests are taken across every ranked run they have on the
 * course, not only the run their best lap came from — the point of a
 * theoretical best is exactly that it crosses laps.
 */
export function buildBoards(runs: SimRun[]): TrackBoard[] {
  const byTrack = new Map<string, SimRun[]>();
  for (const r of runs) {
    const list = byTrack.get(r.track);
    if (list) list.push(r);
    else byTrack.set(r.track, [r]);
  }

  const boards: TrackBoard[] = [];
  for (const [track, all] of byTrack) {
    const ranked = all.filter(isRankable);
    // Keyed on the ACCOUNT, not the display name. A driver who changes their
    // name -- "Nick" to "Nick M." -- would otherwise appear twice, each row
    // claiming one run, with a teammate wedged between them, and would lose
    // every sector best and every second of improvement across the rename.
    const byDriver = new Map<string, DriverEntry>();
    // Every sector time anyone drove on this course, for the team record.
    let sectorRecords: (SectorTime | null)[] = [];

    for (const run of ranked) {
      const best = runBest(run);
      if (best == null) continue;

      const key = run.driverId!;
      const existing = byDriver.get(key);
      const entry: DriverEntry =
        existing ?? {
          driverId: key,
          driver: run.driver,
          best,
          bestRaw: hasTrustworthySectors(run) ? run.stats.bestLapRawS ?? null : null,
          runId: run.runId,
          when: run.startedAt,
          seenTo: run.startedAt,
          cones: run.stats.totalCones,
          runs: 0,
          gap: 0,
          rank: 0,
          bestSectors: [],
          bestLap: run.stats.bestLapNumber ?? null,
          theoretical: null,
          setup: run.stats.setup ?? null,
        };
      if (!existing) byDriver.set(key, entry);

      entry.runs += 1;
      // Show the name from their most recent run, so a rename takes effect
      // rather than leaving the board on whatever they were called first.
      if ((run.startedAt ?? "") >= (entry.seenTo ?? "")) {
        entry.seenTo = run.startedAt;
        entry.driver = run.driver;
      }
      if (best < entry.best) {
        entry.best = best;
        // Only from a run whose raw time belongs to the lap it is shown
        // beside. On a version 1 manifest it is the quickest RAW lap, which is
        // routinely a different lap with more cones on it, so Best minus Raw
        // reads as a penalty that was never applied. Better blank than wrong.
        entry.bestRaw = hasTrustworthySectors(run) ? run.stats.bestLapRawS ?? null : null;
        entry.runId = run.runId;
        entry.bestLap = run.stats.bestLapNumber ?? null;
        entry.setup = run.stats.setup ?? null;
        entry.when = run.startedAt;
        entry.cones = run.stats.totalCones;
      }

      // Sector bests: the run's own per-sector bests, cones included, folded
      // into the driver's and the team's with their source attached.
      //
      // Version 1 sectors are cumulative splits missing their final entry, so
      // folding them in would poison both theoretical bests with numbers that
      // are not sector times at all -- and the result LOOKS like a lap time,
      // which is how it went unnoticed. Those runs still rank on their lap
      // time, which is measured, and simply contribute no sectors. That rule,
      // and the cone rules, live in `runBestSectors`. Only RANKED runs get
      // here, so a run on a course that has since changed shape
      // (`predatesCourse`) supplies no sector record either.
      // Not the skidpad: its "sectors" are whole laps of the circles, and a
      // cone there is 0.125 s, not the 2 s a sector is scored with.
      if (track !== "skidpad") {
        const sectors = runBestSectors(run);
        foldSectors(entry.bestSectors, sectors);
        foldSectors(sectorRecords, sectors);
      }
    }

    const entries = [...byDriver.values()].sort((a, b) => a.best - b.best);
    const leader = entries[0]?.best ?? 0;
    // The skidpad's sectors are whole laps and its score an average: summed,
    // they are not a lap anyone drives (see `runTheoretical`).
    const sums = track !== "skidpad";
    entries.forEach((e, i) => {
      e.rank = i + 1;
      e.gap = e.best - leader;
      // Never slower than the lap they actually drove: sectors are stored to
      // the millisecond, so their sum can land a thousandth over it.
      const t = sums ? sumSectors(e.bestSectors.map((s) => s?.time ?? null)) : null;
      e.theoretical = t == null ? null : unround(t, e.best);
    });

    // A course with no sectors at all should not report an empty record row.
    if (sectorRecords.every((s) => s == null)) sectorRecords = [];

    boards.push({
      track,
      trackName: all[0]?.trackName ?? track,
      entries,
      sectorRecords,
      teamTheoretical: (() => {
        const t = sums ? sumSectors(sectorRecords.map((s) => s?.time ?? null)) : null;
        return t == null ? null : entries.length ? unround(t, leader) : t;
      })(),
      runCount: ranked.length,
      unrankedCount: all.length - ranked.length,
    });
  }

  // Courses with the most activity first; a course nobody has driven this
  // season should not sit at the top of the page.
  boards.sort((a, b) => b.runCount - a.runCount || a.trackName.localeCompare(b.trackName));
  return boards;
}

/** How many of a driver's most recent ranked runs the consistency board averages. */
export const CONSISTENCY_WINDOW = 15;
/** Fewer ranked runs than this and an average is not yet a statement about the driver. */
export const CONSISTENCY_MIN_RUNS = 3;

export interface ConsistencyEntry {
  driverId: string;
  driver: string;
  /** Mean scored lap over the window. */
  average: number;
  /** Sample standard deviation of those laps, 0 with one run. */
  spread: number;
  /** The quickest lap inside the window, and the run it came from. */
  best: number;
  runId: string;
  /** How many runs the average covers (at most `CONSISTENCY_WINDOW`). */
  counted: number;
  /** When the newest run in the window was driven. */
  latest: string | null;
  /** Gap to the leader's average, 0 for the leader. */
  gap: number;
  rank: number;
}

export interface ConsistencyBoard {
  track: string;
  trackName: string;
  /** Drivers with at least `CONSISTENCY_MIN_RUNS` ranked runs, quickest average first. */
  entries: ConsistencyEntry[];
  /** Drivers on the course with too few ranked runs to average yet. */
  pending: { driverId: string; driver: string; counted: number }[];
  runCount: number;
  unrankedCount: number;
}

/**
 * One board per course ranking drivers by the AVERAGE scored lap of their
 * most recent ranked runs, `window` at most.
 *
 * The fastest-lap board rewards the one lap where everything came together;
 * this one rewards doing it every time, which is what an autocross with two
 * runs per driver actually pays for. Recency matters: an average over a
 * driver's whole history punishes them for the runs they did while learning
 * the course, so only the newest `window` runs count, and the board moves as
 * they drive.
 *
 * Only ranked runs count (same rule as the fastest-lap board: a person, no
 * aids, a scored lap), so a driver's window is their last fifteen CLEAN runs,
 * not their last fifteen attempts. An off-course run does not lower the
 * average -- it simply does not enter it -- which is the same treatment the
 * event gives a DNF.
 */
export function buildConsistencyBoards(runs: SimRun[], window = CONSISTENCY_WINDOW): ConsistencyBoard[] {
  const byTrack = new Map<string, SimRun[]>();
  for (const r of runs) {
    const list = byTrack.get(r.track);
    if (list) list.push(r);
    else byTrack.set(r.track, [r]);
  }

  const boards: ConsistencyBoard[] = [];
  for (const [track, all] of byTrack) {
    const ranked = all.filter((r) => isRankable(r) && runBest(r) != null);
    const byDriver = new Map<string, SimRun[]>();
    for (const r of ranked) {
      const list = byDriver.get(r.driverId!);
      if (list) list.push(r);
      else byDriver.set(r.driverId!, [r]);
    }

    const entries: ConsistencyEntry[] = [];
    const pending: ConsistencyBoard["pending"] = [];
    for (const [driverId, list] of byDriver) {
      // Newest first by the run's own clock, whatever order the listing came
      // in; then the window is simply the head of the list.
      const ordered = [...list].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      const recent = ordered.slice(0, window);
      const driver = ordered[0]!.driver;
      if (recent.length < CONSISTENCY_MIN_RUNS) {
        pending.push({ driverId, driver, counted: recent.length });
        continue;
      }
      const times = recent.map((r) => runBest(r)!);
      const average = times.reduce((a, b) => a + b, 0) / times.length;
      const spread = times.length > 1
        ? Math.sqrt(times.reduce((a, t) => a + (t - average) ** 2, 0) / (times.length - 1))
        : 0;
      let bestRun = recent[0]!;
      for (const r of recent) if (runBest(r)! < runBest(bestRun)!) bestRun = r;
      entries.push({
        driverId, driver, average, spread,
        best: runBest(bestRun)!, runId: bestRun.runId,
        counted: recent.length, latest: ordered[0]!.startedAt,
        gap: 0, rank: 0,
      });
    }

    entries.sort((a, b) => a.average - b.average);
    const leader = entries[0]?.average ?? 0;
    entries.forEach((e, i) => { e.rank = i + 1; e.gap = e.average - leader; });
    pending.sort((a, b) => b.counted - a.counted || a.driver.localeCompare(b.driver));

    boards.push({
      track,
      trackName: all[0]?.trackName ?? track,
      entries,
      pending,
      runCount: ranked.length,
      unrankedCount: all.length - ranked.length,
    });
  }
  boards.sort((a, b) => b.runCount - a.runCount || a.trackName.localeCompare(b.trackName));
  return boards;
}

/** A sum of millisecond sectors a hair over the lap it came from is that lap. */
function unround(sum: number, lap: number): number {
  return sum > lap && sum - lap < 0.002 ? lap : sum;
}

/** A theoretical best only means something when every sector has a time. */
function sumSectors(sectors: (number | null)[]): number | null {
  if (!sectors.length) return null;
  let total = 0;
  for (const s of sectors) {
    if (s == null || !Number.isFinite(s)) return null;
    total += s;
  }
  return total;
}

export interface Improvement {
  driverId: string;
  driver: string;
  track: string;
  trackName: string;
  /** The car model and physics era the time was found on: each pair is its
   *  own board, so two rows for one driver on one course are two boards and
   *  have to say which. */
  model: VehicleModel;
  era: number;
  first: number;
  best: number;
  /** Seconds found since their first ranked run on the course. */
  gained: number;
  runs: number;
}

/**
 * How much each driver has found on each course since they started.
 *
 * Ordered by the first run chronologically, which is what "since they started"
 * means — the listing arrives newest-first, so this cannot just take the last
 * element.
 *
 * A driver whose first run is still their best has found nothing, and a row
 * reading "−0.000 s" in the same green as a real gain is worse than no row:
 * only actual improvements are reported.
 */
export function buildImprovements(runs: SimRun[]): Improvement[] {
  const groups = new Map<string, SimRun[]>();
  for (const r of runs) {
    if (!isRankable(r)) continue;
    // Same reason as the board: the account is the identity, not the label.
    // And per model and physics era, as the boards are: a bicycle time then
    // a 4-wheel one is two cars, not an improvement.
    const key = `${r.driverId} ${r.track} ${modelEraKey(r)}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: Improvement[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ordered = [...list].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const first = runBest(ordered[0]!);
    let best: number | null = null;
    for (const r of ordered) best = minDefined(best, runBest(r));
    if (first == null || best == null) continue;
    // Below a thousandth is the timing resolution, not an improvement.
    if (first - best < 0.001) continue;
    out.push({
      driverId: ordered[0]!.driverId!,
      // The name from their LATEST run, so a rename shows the current one.
      driver: ordered[ordered.length - 1]!.driver,
      track: ordered[0]!.track,
      trackName: ordered[0]!.trackName,
      model: vehicleModelOf(ordered[0]!),
      era: physicsEraOf(ordered[0]!),
      first,
      best,
      gained: first - best,
      runs: ordered.length,
    });
  }
  out.sort((a, b) => b.gained - a.gained);
  return out;
}

export interface Activity {
  /** Total runs, including the ones that are not ranked. */
  runs: number;
  drivers: number;
  /** Seconds of wheel time across every run. */
  secondsDriven: number;
  metresDriven: number;
  laps: number;
  cones: number;
  /** The single quickest scored lap anywhere, and where it was set. */
  fastest: { driver: string; track: string; trackName: string; time: number; runId: string } | null;
}

export function buildActivity(runs: SimRun[]): Activity {
  const drivers = new Set<string>();
  let secondsDriven = 0;
  let metresDriven = 0;
  let laps = 0;
  let cones = 0;
  let fastest: Activity["fastest"] = null;

  for (const r of runs) {
    // By ACCOUNT, like every other aggregate here: two teammates who share a
    // display name are two drivers, and one who renames is still one.
    drivers.add(r.driverId ?? `name:${r.driver}`);
    secondsDriven += r.stats.durationS ?? 0;
    metresDriven += r.stats.distanceM ?? 0;
    laps += r.stats.laps ?? 0;
    cones += r.stats.totalCones ?? 0;
    const best = runBest(r);
    // The headline time is a real one: a robot lap is not the team record.
    // And a LAP: a skidpad score or an accel run is a short event time, and
    // would take the banner from every lap of the course by being short.
    const lapCourse = r.track !== "skidpad" && r.track !== "accel";
    if (best != null && lapCourse && isRankable(r) && (fastest == null || best < fastest.time)) {
      fastest = { driver: r.driver, track: r.track, trackName: r.trackName, time: best, runId: r.runId };
    }
  }
  return { runs: runs.length, drivers: drivers.size, secondsDriven, metresDriven, laps, cones, fastest };
}

/**
 * The runs a given run should be offered as a ghost against: the same course
 * AND the same car model -- a bicycle lap beside a 4-wheel one is two cars,
 * not a comparison -- ranked runs only, quickest first, excluding itself. And
 * only runs whose lap is actually somewhere: a shared run whose telemetry was
 * never uploaded, or was pruned, is a time and nothing else; offered as a
 * ghost, the simulator opened the replay and drew "GHOST NOT LOADED" where the
 * car should have been.
 *
 * `driverId` (the viewer) puts their own best first, because "against my PB"
 * is the comparison a driver reaches for; the rest follow quickest first.
 */
export function ghostCandidates(runs: SimRun[], run: SimRun, driverId: string | null = null): SimRun[] {
  const model = vehicleModelOf(run);
  const out = runs
    .filter((r) =>
      r.runId !== run.runId && r.track === run.track && vehicleModelOf(r) === model &&
      isRankable(r) && hasTelemetry(r))
    .sort((a, b) => (runBest(a) ?? Infinity) - (runBest(b) ?? Infinity) || a.runId.localeCompare(b.runId));
  if (driverId) {
    const pb = out.findIndex((r) => r.driverId === driverId);
    if (pb > 0) out.unshift(...out.splice(pb, 1));
  }
  return out;
}

// ---------------------------------------------------------------- board key --

/**
 * Which board a run is ranked on: course, car model, device class and physics
 * era. The Leaderboard draws exactly these boards; everything that says "P3"
 * or "your best" about a run has to mean the same board, or it contradicts the
 * tab beside it.
 */
export interface BoardKey {
  track: string;
  model: VehicleModel;
  device: DeviceClass;
  era: number;
}

export function boardKeyOf(run: SimRun): BoardKey {
  return { track: run.track, model: vehicleModelOf(run), device: deviceClass(run), era: physicsEraOf(run) };
}

export function sameBoard(a: SimRun, b: SimRun): boolean {
  const x = boardKeyOf(a), y = boardKeyOf(b);
  return x.track === y.track && x.model === y.model && x.device === y.device && x.era === y.era;
}

/** "AX", "Accel", "AX K7Q2": a course in as few characters as still say which. */
export function courseShort(track: string): string {
  switch (track) {
    case "autocross": return "AX";
    case "endurance": return "EN";
    case "skidpad": return "Skidpad";
    case "accel": return "Accel";
    case "mis": return "MIS";
  }
  const g = parseGeneratedId(track);
  if (g) return `${g.event === "autocross" ? "AX" : "EN"} ${g.seed}`;
  return trackName(track);
}

/** "Autocross", "Endurance K7Q2": the course without the season on it. */
export function courseName(track: string): string {
  const g = parseGeneratedId(track);
  if (g) return `${GENERATED_EVENTS.find((e) => e.event === g.event)!.name} ${g.seed}`;
  if (track === "accel") return "Accel";
  return trackName(track).replace(/\s+20\d\d$/, "");
}

/** "Autocross · Bicycle · Wheel", with " · rev 2" when `era` is asked for. */
export function boardLabel(key: BoardKey, opts: { era?: boolean; track?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.track !== false) parts.push(courseName(key.track));
  parts.push(VEHICLE_MODELS.find((m) => m.id === key.model)?.name ?? `model ${key.model}`);
  parts.push(DEVICE_CLASSES.find((d) => d.id === key.device)?.short ?? key.device);
  if (opts.era) parts.push(`rev ${key.era}`);
  return parts.join(" · ");
}

/** Where a run's driver stands on the run's own board. */
export interface Standing {
  key: BoardKey;
  /** Null when nothing on that board is ranked. */
  board: TrackBoard | null;
  /** The run's driver on that board; null when they have no ranked time on it. */
  entry: DriverEntry | null;
  leader: DriverEntry | null;
  /** This very run is the driver's best on the board. */
  isDriversBest: boolean;
}

export function boardStanding(runs: SimRun[], run: SimRun): Standing {
  const key = boardKeyOf(run);
  const here = runs.filter((r) => sameBoard(r, run));
  if (!here.some((r) => r.runId === run.runId)) here.push(run);
  const built = buildBoards(here)[0] ?? null;
  const board = built && built.entries.length ? built : null;
  const entry = run.driverId ? board?.entries.find((e) => e.driverId === run.driverId) ?? null : null;
  return {
    key,
    board,
    entry,
    leader: board?.entries[0] ?? null,
    isDriversBest: !!entry && entry.runId === run.runId,
  };
}

/**
 * A driver's best watchable lap on a run's board: the reference for "drive
 * against my PB" and "compare with my PB". Their quickest ranked run on that
 * board that still has its telemetry.
 */
export function bestWatchable(runs: SimRun[], like: SimRun, driverId: string): SimRun | null {
  let best: SimRun | null = null;
  for (const r of runs) {
    if (r.driverId !== driverId || !sameBoard(r, like) || !isRankable(r) || !hasTelemetry(r)) continue;
    const t = runBest(r)!, b = best ? runBest(best)! : Infinity;
    if (t < b || (t === b && best != null && r.runId < best.runId)) best = r;
  }
  return best;
}

/** The board leader's run, when its lap can still be loaded; null otherwise. */
export function leaderWatchable(runs: SimRun[], like: SimRun): SimRun | null {
  const leader = boardStanding(runs, like).leader;
  if (!leader) return null;
  const r = runs.find((x) => x.runId === leader.runId);
  return r && hasTelemetry(r) ? r : null;
}

/**
 * What a run did on its board, for the end-of-session card.
 *
 * `previousBest` is the same driver's best on the SAME board (course, model,
 * device, era) from before this run started. The old rule compared course and
 * driver only, so a first 4-wheel lap was measured against a bicycle best --
 * a different car -- and a keyboard lap against a wheel one.
 *
 * Null for a run that cannot rank: nothing about it is a result.
 */
export interface SessionResult {
  key: BoardKey;
  previousBest: number | null;
  /** Seconds quicker than `previousBest`; negative when slower. */
  improvement: number | null;
  standing: Standing;
  /** This run holds the team record on its board. */
  record: boolean;
}

export function sessionResult(allRuns: SimRun[], run: SimRun): SessionResult | null {
  if (!isRankable(run)) return null;
  const t = runBest(run)!;
  let previousBest: number | null = null;
  for (const r of allRuns) {
    if (r.runId === run.runId || r.driverId !== run.driverId || !sameBoard(r, run) || !isRankable(r)) continue;
    if ((r.startedAt ?? "") >= (run.startedAt ?? "")) continue;
    const b = runBest(r);
    if (b != null && (previousBest == null || b < previousBest)) previousBest = b;
  }
  const standing = boardStanding(allRuns, run);
  return {
    key: standing.key,
    previousBest,
    improvement: previousBest != null ? previousBest - t : null,
    standing,
    record: standing.leader?.runId === run.runId,
  };
}

// ---------------------------------------------------------- course summaries --

export interface CourseBest {
  track: string;
  /** `courseShort`: "AX", "Accel". */
  short: string;
  best: number;
  runId: string;
  /** Runs on the course in the list, timed or not. */
  runs: number;
}

/**
 * The quickest time on each course in a list of runs, busiest course first.
 *
 * A day, or a session, is often more than one course, and one "best" across
 * them means nothing: an accel run's 4.352 is not quicker than an autocross
 * lap, it is a different event. Courses with no time at all are left out.
 */
export function bestPerCourse(runs: SimRun[]): CourseBest[] {
  const by = new Map<string, CourseBest>();
  for (const r of runs) {
    let c = by.get(r.track);
    if (!c) {
      c = { track: r.track, short: courseShort(r.track), best: Infinity, runId: "", runs: 0 };
      by.set(r.track, c);
    }
    c.runs += 1;
    const t = runBest(r);
    if (t != null && t < c.best) { c.best = t; c.runId = r.runId; }
  }
  return [...by.values()]
    .filter((c) => Number.isFinite(c.best))
    .sort((a, b) => b.runs - a.runs || a.short.localeCompare(b.short));
}

// ----------------------------------------------------------- recent records --

export interface RecordEvent {
  /** "record": the quickest anyone had been on the board at that moment.
   *  "pb": quicker than the driver had been before, but not a record. */
  kind: "record" | "pb";
  runId: string;
  driver: string;
  driverId: string;
  key: BoardKey;
  time: number;
  /** The time it beat: the previous record, or the driver's previous best.
   *  Null for the first time anyone set on the board. */
  previous: number | null;
  /** When the run was driven. */
  at: string;
}

/**
 * The newest personal bests and team records, newest first.
 *
 * Replaces one "best lap anyone has scored" across every course, model and
 * era -- a comparison between times that do not compare, which a bicycle
 * autocross lap "won" against a 4-wheel one. Each event is judged on its own
 * board (`boardKeyOf`), in the order the laps were driven.
 */
export function buildRecentRecords(runs: SimRun[], limit = 6): RecordEvent[] {
  const ranked = runs
    .filter((r) => isRankable(r) && !!r.startedAt && !Number.isNaN(Date.parse(r.startedAt)))
    .sort((a, b) => a.startedAt!.localeCompare(b.startedAt!) || a.runId.localeCompare(b.runId));
  const team = new Map<string, number>();
  const own = new Map<string, number>();
  const out: RecordEvent[] = [];
  for (const r of ranked) {
    const key = boardKeyOf(r);
    const k = `${key.track}|${key.model}|${key.device}|${key.era}`;
    const mk = `${k}|${r.driverId}`;
    const t = runBest(r)!;
    const rec = team.get(k);
    const mine = own.get(mk);
    const base = { runId: r.runId, driver: r.driver, driverId: r.driverId!, key, time: t, at: r.startedAt! };
    // A thousandth is the timing resolution: equalling a time is not beating it.
    if (rec == null || t < rec - 0.0005) {
      out.push({ ...base, kind: "record", previous: rec ?? null });
      team.set(k, t);
    } else if (mine != null && t < mine - 0.0005) {
      out.push({ ...base, kind: "pb", previous: mine });
    }
    if (mine == null || t < mine) own.set(mk, t);
  }
  return out.reverse().slice(0, limit);
}

/** A lap that set a time: it stayed on the course. The same test the sector
 *  fold uses (`lapSectorPieces`), so the lap table and the board agree. */
export function lapCounts(lap: Pick<SimLap, "valid" | "off">): boolean {
  return lap.valid !== false && (lap.off ?? 0) === 0;
}

// ------------------------------------------------------- sector comparison --

/** A lap to open: which run, and which lap of it (null: the run's own pick). */
export interface LapPick {
  runId: string;
  lap: number | null;
}

/**
 * What the sector card shows and what its two buttons do.
 *
 * `target` is the time being looked at -- a team record, or one of the
 * driver's own best sectors. `mine` is the number it is compared with.
 * `against` is the driver's own lap that goes beside it in the replay (as the
 * ghost) and in Logs (as the reference): a lap with telemetry, or null when
 * the driver has none on the course.
 */
export interface SectorComparison {
  /** 0-based. */
  sector: number;
  target: SectorTime;
  mine: SectorTime | null;
  /** What `mine` is, for the card: "Your best S2", "Your best lap's S2". */
  mineLabel: string;
  against: (LapPick & { label: string }) | null;
}

/** The time a given lap of a run drove sector `i`, penalised; null if it cannot count. */
export function lapSectorTime(run: SimRun, lapNo: number | null, i: number): SectorTime | null {
  if (lapNo == null || !hasTrustworthySectors(run)) return null;
  const lap = run.laps?.find((l) => l.lap === lapNo);
  if (!lap) return null;
  const p = lapSectorPieces(lap)[i];
  return p ? sourced(run, lapNo, p) : null;
}

/**
 * Compare team sector record `i` with the signed-in driver.
 *
 * `runs` must be the SAME runs the board was built from (the same device
 * class), so "your best" means best on the board being looked at.
 *
 * The lap put beside the record is the driver's own best time in that sector
 * among the laps they can still watch, falling back to their best lap. Never
 * the record lap itself: when the record is theirs, it is their best LAP that
 * goes beside it, which is the question "where does my perfect lap beat my
 * real one" in the only form a replay can answer it.
 */
export function compareRecord(
  runs: SimRun[],
  board: TrackBoard,
  i: number,
  driverId: string | null,
): SectorComparison | null {
  const target = board.sectorRecords[i];
  if (!target) return null;
  const entry = driverId ? board.entries.find((e) => e.driverId === driverId) : undefined;
  const mine = entry?.bestSectors[i] ?? null;
  return {
    sector: i,
    target,
    mine,
    mineLabel: `Your best S${i + 1}`,
    against: driverId ? ownLapFor(runs, board, i, driverId, target) : null,
  };
}

/**
 * Compare the signed-in driver's own best sector `i` with the same sector of
 * their best lap: where the perfect lap beats the real one.
 */
export function compareOwnSector(
  runs: SimRun[],
  board: TrackBoard,
  i: number,
  driverId: string,
): SectorComparison | null {
  const entry = board.entries.find((e) => e.driverId === driverId);
  const target = entry?.bestSectors[i];
  if (!entry || !target) return null;
  const bestRun = runs.find((r) => r.runId === entry.runId);
  const onBestLap = bestRun ? lapSectorTime(bestRun, entry.bestLap, i) : null;
  const same = target.runId === entry.runId && target.lap === entry.bestLap;
  return {
    sector: i,
    target,
    mine: onBestLap,
    mineLabel: `Your best lap's S${i + 1}`,
    against: !same && bestRun && hasTelemetry(bestRun)
      ? { runId: entry.runId, lap: entry.bestLap, label: "your best lap" }
      : null,
  };
}

/** The driver's own lap to put beside `target` in sector `i`. See `compareRecord`. */
function ownLapFor(
  runs: SimRun[],
  board: TrackBoard,
  i: number,
  driverId: string,
  target: SectorTime,
): (LapPick & { label: string }) | null {
  const isTarget = (runId: string, lap: number | null) => runId === target.runId && lap === target.lap;
  // Only runs that could be on this board: ranked, this course. An old-course
  // run is a different shape, and its "S2" is a different piece of road.
  const mine = runs.filter((r) => r.track === board.track && r.driverId === driverId && isRankable(r) && hasTelemetry(r));
  let best: SectorTime | null = null;
  for (const r of mine) {
    for (const lap of r.laps ?? []) {
      if (isTarget(r.runId, lap.lap)) continue;
      const t = lapSectorTime(r, lap.lap, i);
      if (t && sectorBeats(t, best)) best = t;
    }
  }
  if (best) return { runId: best.runId, lap: best.lap, label: `your best S${i + 1}` };
  // No lap of theirs with a clean time in that sector: their best lap will do.
  const byLap = [...mine].sort((a, b) => (runBest(a) ?? Infinity) - (runBest(b) ?? Infinity) || a.runId.localeCompare(b.runId));
  for (const r of byLap) {
    const lap = r.stats.bestLapNumber ?? null;
    if (!isTarget(r.runId, lap)) return { runId: r.runId, lap, label: "your best lap" };
  }
  return null;
}

/**
 * Where sector `i` of a lap lies on the run's own clock, in seconds -- the
 * clock the telemetry's `time_s` column is written in, so `* 1e6` is the
 * microsecond timebase Logs loads it into. Null when it cannot be placed: an
 * unknown lap, or an untimed sector at or before `i`.
 */
export function sectorWindowS(run: SimRun, lapNo: number | null, i: number): { startS: number; endS: number } | null {
  if (lapNo == null) return null;
  const lap = run.laps?.find((l) => l.lap === lapNo);
  if (!lap || !Number.isFinite(lap.startedAtS)) return null;
  let start = lap.startedAtS;
  for (let k = 0; k < i; k++) {
    const s = lap.sectors?.[k];
    if (s == null || !Number.isFinite(s)) return null;
    start += s;
  }
  const len = lap.sectors?.[i];
  if (len == null || !Number.isFinite(len)) return null;
  return { startS: start, endS: start + len };
}

/**
 * Every run that holds something on a team board: a course's best lap, or a
 * sector record. Judged per device class, as the boards are drawn.
 *
 * For the retention rule, which keeps these laps watchable: a record that can
 * only be read, never watched, answers "how much quicker" and not "where".
 */
export function recordHolders(runs: SimRun[]): Set<string> {
  const byClass = new Map<string, SimRun[]>();
  for (const r of runs) {
    // Per model and era too, as the boards are drawn: a record on the
    // bicycle board is kept watchable whatever the 4-wheel board says.
    const c = `${deviceClass(r)} ${modelEraKey(r)}`;
    const list = byClass.get(c);
    if (list) list.push(r);
    else byClass.set(c, [r]);
  }
  const out = new Set<string>();
  for (const list of byClass.values()) {
    for (const b of buildBoards(list)) {
      if (b.entries[0]) out.add(b.entries[0].runId);
      for (const s of b.sectorRecords) if (s) out.add(s.runId);
    }
  }
  return out;
}
