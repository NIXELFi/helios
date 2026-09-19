/* Turning a pile of runs into the numbers a race team argues about.
 *
 * All pure functions over the run listing, so every one of them is testable
 * without a filesystem, a simulator or a window.
 *
 * The thing worth being careful about is which time counts. A lap has a raw
 * time and a scored total (raw plus two seconds a cone and ten an excursion),
 * and the scored total is the one that matters — it is what the event scores.
 * `stats.bestLapS` is already the scored total, so that is what ranks. Raw is
 * carried alongside because it is what tells a driver whether they were quick
 * and untidy or just slow.
 */

import { hasTrustworthySectors, isRankable, runBest, type SimRun } from "../api";

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
  /** Their own best each sector, across every ranked run on the course. */
  bestSectors: (number | null)[];
  /** Those sectors added up: the lap they have already driven in pieces. */
  theoretical: number | null;
}

export interface TrackBoard {
  track: string;
  trackName: string;
  entries: DriverEntry[];
  /** The quickest each sector has been driven by anyone. */
  sectorRecords: (number | null)[];
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
    let sectorRecords: (number | null)[] = [];

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
          theoretical: null,
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
        entry.when = run.startedAt;
        entry.cones = run.stats.totalCones;
      }

      // Sector bests: the run's own per-sector bests, folded into the
      // driver's and the team's.
      //
      // Version 1 sectors are cumulative splits missing their final entry, so
      // folding them in would poison both theoretical bests with numbers that
      // are not sector times at all -- and the result LOOKS like a lap time,
      // which is how it went unnoticed. Those runs still rank on their lap
      // time, which is measured, and simply contribute no sectors.
      const sectors = hasTrustworthySectors(run) ? run.stats.bestSectors ?? [] : [];
      for (let i = 0; i < sectors.length; i++) {
        entry.bestSectors[i] = minDefined(entry.bestSectors[i] ?? null, sectors[i]);
        sectorRecords[i] = minDefined(sectorRecords[i] ?? null, sectors[i]);
      }
    }

    const entries = [...byDriver.values()].sort((a, b) => a.best - b.best);
    const leader = entries[0]?.best ?? 0;
    entries.forEach((e, i) => {
      e.rank = i + 1;
      e.gap = e.best - leader;
      e.theoretical = sumSectors(e.bestSectors);
    });

    // A course with no sectors at all should not report an empty record row.
    if (sectorRecords.every((s) => s == null)) sectorRecords = [];

    boards.push({
      track,
      trackName: all[0]?.trackName ?? track,
      entries,
      sectorRecords,
      teamTheoretical: sumSectors(sectorRecords),
      runCount: ranked.length,
      unrankedCount: all.length - ranked.length,
    });
  }

  // Courses with the most activity first; a course nobody has driven this
  // season should not sit at the top of the page.
  boards.sort((a, b) => b.runCount - a.runCount || a.trackName.localeCompare(b.trackName));
  return boards;
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
    const key = `${r.driverId} ${r.track}`;
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
    if (best != null && isRankable(r) && (fastest == null || best < fastest.time)) {
      fastest = { driver: r.driver, track: r.track, trackName: r.trackName, time: best, runId: r.runId };
    }
  }
  return { runs: runs.length, drivers: drivers.size, secondsDriven, metresDriven, laps, cones, fastest };
}

/**
 * The runs a given run should be offered as a ghost against: the same course,
 * quickest first, excluding itself.
 */
export function ghostCandidates(runs: SimRun[], run: SimRun): SimRun[] {
  return runs
    .filter((r) => r.runId !== run.runId && r.track === run.track && runBest(r) != null)
    .sort((a, b) => (runBest(a) ?? Infinity) - (runBest(b) ?? Infinity));
}
