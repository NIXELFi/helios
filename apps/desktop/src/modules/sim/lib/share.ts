/* Sharing runs with the rest of the team.
 *
 * The archive is local files and stays local files: the simulator writes a
 * directory, Helios reads it, and a rig at a test day with no network works
 * exactly as it always did. This module is the half that travels.
 *
 * WHAT TRAVELS. Every run's times, penalties and stats go up as one small
 * row, because a leaderboard that only knows about the machine it is running
 * on is not a leaderboard -- it is a diary, and it looks identical. On top of
 * that, a run that sets its driver's best on a course also carries its
 * telemetry, so a teammate can watch that lap and race its ghost. Practice
 * runs do not: a season of them would be a season of megabytes for laps
 * nobody will open.
 *
 * WHAT DOES NOT TRAVEL, and why. Identity: `sim.runs` stamps `user_id` from
 * the session in a trigger and ignores whatever the client sends, so a row
 * can only ever be posted as yourself. The client here is careful to push
 * only runs whose recorded `driverId` IS the signed-in account -- on a shared
 * rig the local archive holds other people's drives, and posting those would
 * file somebody else's lap under your name. The database would let you; the
 * point is not to.
 */

import type { SupabaseClient } from "@helios/auth";

import { deviceClass, isRankable, runBest, type SimRun } from "../api";

const TABLE = "runs";
const SCHEMA = "sim";
const BUCKET = "sim-telemetry";

/** One row of `sim.runs`, as PostgREST hands it over. */
interface RunRow {
  run_id: string;
  user_id: string;
  display_name: string | null;
  subteam: string | null;
  driver: string | null;
  track: string;
  track_name: string | null;
  started_at: string | null;
  best_lap_s: number | null;
  laps: number;
  total_cones: number;
  assists: { traction?: boolean; abs?: boolean; autoShift?: boolean } | null;
  synthetic: boolean;
  format_version: number;
  profile: string | null;
  detected_input: string | null;
  stats: Record<string, unknown> | null;
  laps_detail: unknown[] | null;
  telemetry_object: string | null;
  telemetry_bytes: number | null;
}

/**
 * A shared row, dressed as the `SimRun` the rest of the module already knows.
 *
 * Deliberately the same shape rather than a parallel type: the runs table,
 * the leaderboard, the detail panel and `isRankable` then work on a
 * teammate's run without knowing it is one, and there is exactly one
 * definition of what makes a time count.
 */
export function rowToRun(row: RunRow): SimRun {
  // The manifest's shape is not fixed -- the simulator adds fields -- so the
  // column is jsonb and this is the one place it is trusted. Every field the
  // UI actually depends on is either promoted to a column (and restored
  // below) or guarded at its use site.
  const stats = (row.stats ?? {}) as unknown as SimRun["stats"];
  return {
    formatVersion: row.format_version ?? 1,
    sampleRateHz: (stats as { sampleRateHz?: number }).sampleRateHz ?? null,
    runId: row.run_id,
    // No files on this machine. `dir` and `telemetryPath` being empty is what
    // every "can I open this locally" check keys off.
    dir: "",
    telemetryPath: "",
    telemetryBytes: 0,
    driver: row.driver || row.display_name || "Unknown",
    driverId: row.user_id,
    session: null,
    track: row.track,
    trackName: row.track_name || row.track,
    startedAt: row.started_at,
    finishedReason: null,
    // What it was driven with. The boards are separated by device class and
    // cannot be without this; a shared run used to arrive with it stripped.
    profile: row.profile ?? null,
    // And what it was ACTUALLY driven with. `deviceClass` prefers this; the
    // profile beside it is a dropdown and a board cannot be separated by one.
    detectedInput: row.detected_input ?? null,
    device: null,
    physics: null,
    simVersion: null,
    synthetic: row.synthetic,
    // Carried in `stats` rather than promoted to a column: nothing sorts on
    // it. Zero on a row pushed before it travelled, which the panel shows as
    // unknown rather than as a count.
    samples: (stats as { samples?: number }).samples ?? 0,
    assists: {
      traction: !!row.assists?.traction,
      abs: !!row.assists?.abs,
      autoShift: !!row.assists?.autoShift,
    },
    laps: (row.laps_detail ?? []) as SimRun["laps"],
    stats: { ...stats, bestLapS: row.best_lap_s, laps: row.laps, totalCones: row.total_cones },
    remote: true,
    sharedBy: row.display_name,
    subteam: row.subteam,
    telemetryObject: row.telemetry_object,
    telemetrySharedBytes: row.telemetry_bytes ?? 0,
  };
}

/**
 * The columns a push writes: everything the boards read, and NOT the two
 * telemetry columns.
 *
 * PostgREST's upsert is `insert ... on conflict do update set col =
 * excluded.col` for every key in the payload, so a key that is present is
 * written whether or not this side meant anything by it. These two used to be
 * sent as null, which was true of a new run and false of every run that had
 * its lap up. A re-push -- and a re-push is now routine, because `rowStamp`
 * exists to correct rows that have gone stale -- nulled the pointer to an
 * object that was still in the bucket. The upload loop did not replace it,
 * because it had read the row before the upsert and still believed the object
 * was there; the prune loop could never remove it, because nothing pointed at
 * it any more. Every lap the team had shared would have gone that way on the
 * next sign-in, and nineteen megabytes with it. Left out of the payload, the
 * server keeps whatever it has: the pointer is written only by the code that
 * uploaded the object and cleared only by the code that removed it.
 */
function runToRow(
  run: SimRun,
): Omit<RunRow, "user_id" | "display_name" | "subteam" | "telemetry_object" | "telemetry_bytes"> {
  return {
    run_id: run.runId,
    driver: run.driver,
    track: run.track,
    track_name: run.trackName,
    started_at: run.startedAt,
    best_lap_s: runBest(run),
    laps: run.stats.laps ?? 0,
    total_cones: run.stats.totalCones ?? 0,
    assists: run.assists,
    synthetic: run.synthetic,
    format_version: run.formatVersion ?? 1,
    profile: run.profile,
    detected_input: run.detectedInput,
    // The sample count rides in `stats` beside the rate. It was left out, so
    // every shared run reported "0 samples at 99 Hz" -- and importing one
    // wrote that zero into the local manifest, where it stayed.
    stats: { ...run.stats, sampleRateHz: run.sampleRateHz, samples: run.samples },
    laps_detail: run.laps ?? [],
  };
}

/**
 * How many rows to ask for at a time.
 *
 * PostgREST caps a response at its own `max-rows`, which this project sets to
 * 1000, and it does so SILENTLY -- there is no error and no flag, the reply is
 * simply a thousand rows long. Asking for 2000 in one request therefore did
 * not fetch 2000; it fetched the newest thousand and dropped the rest on the
 * floor, and because the order is newest first, the rows it dropped were the
 * oldest. A team a season into practice would have watched October's personal
 * bests quietly leave the board in March.
 *
 * Matching the server's cap is what makes the paging below terminate on the
 * right signal: a short page is the end of the table, and a full page never
 * is.
 */
const PAGE = 1000;

/**
 * Every run the team has shared, newest first.
 *
 * Paged, because the server will not send more than `PAGE` at once however
 * many are asked for. `limit` is still a real ceiling -- a board is a screen,
 * not an archive -- but it is now a number this function honours rather than
 * one it hands to something that ignores it.
 */
export async function fetchSharedRuns(client: SupabaseClient, limit = 5000): Promise<SimRun[]> {
  const rows: RunRow[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const res = await client
      .schema(SCHEMA)
      .from(TABLE)
      .select("*")
      // Ties broken by run_id: `started_at` is not unique (two rigs can file a
      // run in the same second), and a page boundary that falls inside a tie
      // with no tiebreak can repeat a row on one page and skip another.
      .order("started_at", { ascending: false })
      .order("run_id", { ascending: false })
      .range(from, to);
    if (res.error) throw new Error(`read shared runs: ${res.error.message}`);
    const page = res.data as RunRow[];
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }
  return rows.map(rowToRun);
}

/**
 * What this user already has up there: every row of theirs, whole.
 *
 * Whole rows rather than `run_id` alone, for two reasons that arrived one
 * after the other. First the stamp: a run is pushed once and then never
 * looked at again, so a column added later -- or a manifest re-read after a
 * simulator update -- would never reach the server: `profile` and
 * `detected_input` went in and all 54 existing rows stayed null, which put
 * every run the team had already driven on the "Unrecorded device" board and
 * left the wheel board empty. Then the retention rule: it is a rule about a
 * DRIVER's runs, and a driver has more than one machine. Judged from this
 * machine's archive alone, a laptop holding one run pruned the four laps the
 * rig had shared, and the rig put them back and pruned the laptop's -- see
 * `pushRuns`. Judging every run the driver has means holding every run the
 * driver has, and the row carries all of what the rule reads.
 */
async function sharedRowsFor(
  client: SupabaseClient,
  userId: string,
): Promise<Map<string, SharedState>> {
  const res = await client
    .schema(SCHEMA)
    .from(TABLE)
    .select("*")
    .eq("user_id", userId);
  if (res.error) throw new Error(`read shared runs: ${res.error.message}`);
  const out = new Map<string, SharedState>();
  for (const r of res.data as RunRow[]) {
    out.set(r.run_id, {
      telemetryObject: r.telemetry_object,
      stamp: rowStamp(r),
      run: rowToRun(r),
    });
  }
  return out;
}

interface SharedState {
  telemetryObject: string | null;
  /** See `rowStamp`. */
  stamp: string;
  /** The row as a run, for the retention rule. */
  run: SimRun;
}

/**
 * The fields worth re-pushing for, as one comparable string.
 *
 * Deliberately not every column. Re-pushing all of a driver's runs on every
 * sign-in would rewrite hundreds of rows to change nothing, and `updated_at`
 * with them; comparing nothing re-pushes none of them and lets the table rot.
 * These four are the ones that have actually changed under an existing run:
 * what it was driven with, what the simulator observed steering it, which
 * manifest format wrote it, and the time itself -- which moves when a rule
 * changes, as it did the day an off-course lap stopped scoring.
 *
 * It converges: one sign-in after a change brings every row current, and the
 * next one writes nothing.
 */
export function rowStamp(r: {
  profile: string | null;
  detected_input: string | null;
  format_version: number | null;
  best_lap_s: number | null;
}): string {
  return [r.profile ?? "", r.detected_input ?? "", r.format_version ?? 0, r.best_lap_s ?? ""].join("|");
}

/** Shared telemetry from a non-wheel run is thinned to this. */
export const NON_WHEEL_SHARE_HZ = 10;

/**
 * Thin a telemetry CSV to roughly `hz`, keeping the header and the shape.
 *
 * Only for runs not driven on a wheel. The reasoning is proportionate rather
 * than dismissive: a pad or a keyboard lap is worth having on the board and
 * worth glancing at, but nobody is going to study its steering trace at 100 Hz
 * -- the input is a stick or a switch that software has already smoothed, so
 * the detail those rows carry was never in the driving. A tenth of the rows is
 * still plenty to see the line and the pedal work, and an endurance run stops
 * being eleven megabytes.
 *
 * Row-count based, not time based, so it needs nothing from the header beyond
 * knowing which column is time. Helios measures a group's real rate from the
 * rows it finds (see `measured_rate_hz`), so a thinned file describes itself
 * correctly with no extra bookkeeping.
 */
export function thinCsv(text: string, fromHz: number, toHz: number): string {
  if (!(fromHz > toHz) || toHz <= 0) return text;
  const step = Math.max(1, Math.round(fromHz / toHz));
  if (step <= 1) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let kept = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i === 0) { out.push(line); continue; }      // header
    if (line === "") continue;                       // trailing newline
    if (kept++ % step === 0) out.push(line);
  }
  return out.join("\n") + "\n";
}

/**
 * Squeeze the telemetry on its way up.
 *
 * About 3x on this data -- a CSV of floats does not compress like prose, and
 * an earlier estimate of 10x was wishful. Still the difference between 11 MB
 * and 3.7 MB for an endurance run, for a few lines and no loss.
 *
 * `CompressionStream` is in every Chromium, which is what the webview is.
 * Where it somehow is not, the plain bytes go up instead and the `.gz` suffix
 * is what tells the reader which it got.
 */
async function gzip(body: Uint8Array): Promise<{ body: Uint8Array; gz: boolean }> {
  if (typeof CompressionStream !== "function") return { body, gz: false };
  try {
    const stream = new Blob([body as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return { body: packed, gz: true };
  } catch {
    return { body, gz: false };
  }
}

/** Telemetry kept per course: the quickest this many ranked runs... */
export const KEEP_BEST = 2;
/** ...and the last this many, whether they were quick or not. */
export const KEEP_RECENT = 3;

/**
 * Which of this driver's runs keep their telemetry shared.
 *
 * Per COURSE: the best `KEEP_BEST` ranked runs, plus the most recent
 * `KEEP_RECENT`, as a union -- so a new personal best usually occupies a slot
 * in both and the real total sits under five.
 *
 * Over every run the driver has, wherever it is: a row the server holds and
 * this disk does not counts exactly as a local run does. The rule is about a
 * driver, and a driver with two machines has to get the same answer from
 * both, or each machine deletes what the other keeps. It used to skip runs
 * marked `remote`, which made the rule a rule about a machine -- and made a
 * laptop with one run prune everything the rig had shared.
 *
 * It is a RETENTION rule, not a selection one, and that distinction is the
 * whole point. Sharing "the best lap on each course" sounds bounded and is
 * not: the object path carries the run id, so every new personal best added a
 * file and the one it beat stayed for ever. Storage grew with how much the
 * team practised, which is exactly the thing you do not want to charge people
 * for. Bounding the set means `pushRuns` can delete what falls out of it.
 *
 * Best is drawn from RANKED runs only -- an assisted or off-course lap is not
 * a benchmark. Recent is drawn from anything that completed a lap, including
 * the ones that went off: a lap you just threw away is often the one worth
 * watching, and it ages out on its own in three more runs.
 */
export function telemetryToKeep(runs: SimRun[], userId: string): Set<string> {
  const mine = runs.filter((r) => r.driverId === userId && !r.synthetic);
  const byCourse = new Map<string, SimRun[]>();
  for (const r of mine) {
    const list = byCourse.get(r.track);
    if (list) list.push(r);
    else byCourse.set(r.track, [r]);
  }

  const keep = new Set<string>();
  for (const list of byCourse.values()) {
    const ranked = list
      .filter((r) => isRankable(r) && runBest(r) != null)
      .sort((a, b) => (runBest(a) as number) - (runBest(b) as number));
    for (const r of ranked.slice(0, KEEP_BEST)) keep.add(r.runId);

    const withALap = list
      .filter((r) => (r.stats.laps ?? 0) > 0)
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    for (const r of withALap.slice(0, KEEP_RECENT)) keep.add(r.runId);
  }
  return keep;
}

export interface SyncResult {
  pushed: number;
  telemetryPushed: number;
  /** Telemetry removed because the run fell out of `telemetryToKeep`. */
  telemetryPruned: number;
  /** Objects removed because no row pointed at them -- unreachable by any
   *  code path, and invisible to `telemetryPruned`, which reads the rows. */
  telemetrySwept: number;
  skippedNotMine: number;
  error: string | null;
}

/**
 * Push what this machine has and the team does not.
 *
 * Only runs recorded against the signed-in account. The rest of the local
 * archive belongs to whoever else has driven at this rig, and filing their
 * laps under your name would be worse than not sharing them at all -- they
 * will share their own when they sign in.
 */
export async function pushRuns(
  client: SupabaseClient,
  userId: string,
  local: SimRun[],
  readTelemetry: (run: SimRun) => Promise<Uint8Array | null>,
): Promise<SyncResult> {
  const out: SyncResult = {
    pushed: 0, telemetryPushed: 0, telemetryPruned: 0, telemetrySwept: 0,
    skippedNotMine: 0, error: null,
  };
  const mine = local.filter((r) => {
    if (r.remote) return false;
    if (r.driverId !== userId) { out.skippedNotMine++; return false; }
    return true;
  });
  if (!mine.length) return out;

  let already: Map<string, SharedState>;
  try {
    already = await sharedRowsFor(client, userId);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }

  // The retention rule is judged over everything this driver has, not over
  // what happens to be on this disk. It used to be the local archive alone,
  // and a driver with two machines then had two different rules: a laptop
  // holding one run looked at the five the rig had shared, found none of them
  // in ITS keep set, and deleted all four of the rig's laps -- and the rig's
  // next sync put them back and deleted the laptop's, indefinitely. Local
  // runs first, so a manifest re-read on this machine wins over the copy of
  // it up there; the rest come from the rows, which carry all the rule reads.
  const localIds = new Set(mine.map((r) => r.runId));
  const everything = [
    ...mine,
    ...[...already.values()].map((s) => s.run).filter((r) => !localIds.has(r.runId)),
  ];
  const wantTelemetry = telemetryToKeep(everything, userId);

  // Metadata first, in one round trip. Upsert rather than insert, because a
  // run that is already up there and no longer matches what this machine has
  // should be corrected rather than collide -- which is the case `already.has`
  // alone used to skip, so a column added after a run was pushed never reached
  // it. `rowStamp` says what counts as no longer matching.
  const rows = mine.map((r) => [r, runToRow(r)] as const);
  const stale = rows.filter(([r, row]) => {
    const there = already.get(r.runId);
    return !there || there.stamp !== rowStamp(row);
  });
  if (stale.length) {
    const res = await client
      .schema(SCHEMA)
      .from(TABLE)
      .upsert(stale.map(([, row]) => row), { onConflict: "run_id" });
    if (res.error) {
      out.error = `share runs: ${res.error.message}`;
      return out;
    }
    out.pushed = stale.length;
  }

  // Which object each row points at, kept current through the uploads and
  // prunes below. The sweep at the end judges the state this call leaves
  // behind, not the one it found; read once at the top, it would collect the
  // object uploaded a moment ago.
  const objectOf = new Map<string, string | null>();
  for (const [runId, s] of already) objectOf.set(runId, s.telemetryObject);

  // Then the telemetry for the laps worth watching, one at a time: they are
  // megabytes and a failure on one must not lose the others.
  for (const run of mine) {
    if (!wantTelemetry.has(run.runId)) continue;
    if (objectOf.get(run.runId)) continue;
    try {
      const raw = await readTelemetry(run);
      if (!raw || !raw.length) continue;
      // A wheel run shares every row; anything else is thinned. See `thinCsv`.
      const thinned = deviceClass(run) === "wheel"
        ? raw
        : new TextEncoder().encode(
            thinCsv(new TextDecoder().decode(raw), run.sampleRateHz ?? 100, NON_WHEEL_SHARE_HZ),
          );
      const { body, gz } = await gzip(thinned);
      const object = `${userId}/${run.runId}.csv${gz ? ".gz" : ""}`;
      const up = await client.storage
        .from(BUCKET)
        .upload(object, body as BlobPart, {
          contentType: gz ? "application/gzip" : "text/csv",
          upsert: true,
        });
      if (up.error) throw new Error(up.error.message);
      const mark = await client
        .schema(SCHEMA)
        .from(TABLE)
        .update({ telemetry_object: object, telemetry_bytes: body.length })
        .eq("run_id", run.runId);
      if (mark.error) throw new Error(mark.error.message);
      objectOf.set(run.runId, object);
      out.telemetryPushed++;
    } catch (e) {
      // One lap's telemetry failing is not a reason to stop: the times are
      // already shared and that is the part the board needs.
      out.error = e instanceof Error ? e.message : String(e);
    }
  }

  // And drop what has fallen out of the rule. This is the half that makes it
  // a bound rather than a preference: without it the bucket only ever grows,
  // one file per personal best, for as long as the team practises.
  //
  // Only ever this user's own objects -- storage RLS enforces the same thing,
  // and the run row belongs to them too.
  for (const [runId, object] of objectOf) {
    if (!object || wantTelemetry.has(runId)) continue;
    try {
      const rm = await client.storage.from(BUCKET).remove([object]);
      if (rm.error) throw new Error(rm.error.message);
      const clear = await client
        .schema(SCHEMA)
        .from(TABLE)
        .update({ telemetry_object: null, telemetry_bytes: null })
        .eq("run_id", runId);
      if (clear.error) throw new Error(clear.error.message);
      objectOf.set(runId, null);
      out.telemetryPruned++;
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
  }

  // And anything in this user's folder that no row points at. The rows are
  // the only record of what is up there, and for a while they were wrong: a
  // re-push nulled the pointer while the object stayed, and from then on
  // nothing could reach it -- the download reads the pointer, the prune above
  // reads the pointer. Listing the folder is the one view that does not
  // depend on the pointer having been right, and it is what makes the bound a
  // bound on the bucket rather than on the table. Only the names this module
  // writes are judged; anything else under the folder is not its to delete.
  //
  // One shape is left alone: an object whose run is in the keep set and whose
  // row has no pointer yet. That is what another machine's upload looks like
  // between its two round trips -- the object lands, then the row is marked
  // -- and collecting it would leave that row pointing at nothing. Had this
  // machine held the file, the loop above would already have uploaded and
  // marked it, so anything still in that state is somebody else's, in
  // progress.
  const listed = await client.storage.from(BUCKET).list(userId, { limit: 1000 });
  if (listed.error) {
    out.error = `list shared telemetry: ${listed.error.message}`;
    return out;
  }
  const pointed = new Set([...objectOf.values()].filter((o): o is string => !!o));
  for (const f of listed.data ?? []) {
    // A folder lists with no id; there should be none, and it is not a file.
    if (f.id == null || !/\.csv(\.gz)?$/.test(f.name)) continue;
    const object = `${userId}/${f.name}`;
    if (pointed.has(object)) continue;
    const runId = f.name.replace(/\.csv(\.gz)?$/, "");
    if (wantTelemetry.has(runId) && objectOf.has(runId) && objectOf.get(runId) == null) continue;
    try {
      const rm = await client.storage.from(BUCKET).remove([object]);
      if (rm.error) throw new Error(rm.error.message);
      out.telemetrySwept++;
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}

/**
 * Take one of your own runs off the team's board, lap and all.
 *
 * There was no way to do this. Deleting a run removed the directory and left
 * the row, so the run came straight back with a cloud icon, still ranked; the
 * button said "for good" and meant "from this disk". The row goes first and
 * says what it pointed at, so the object can follow. If that second step
 * fails, the sweep in `pushRuns` collects it on the next sync -- an object
 * with no row is exactly what the sweep is for. Table and storage RLS both
 * refuse anybody else's, so this cannot take down a teammate's run however it
 * is called.
 *
 * Another machine of yours that still holds the files will share the run
 * again the next time it syncs: from where it stands the run is simply one
 * the server has not seen. That is the honest limit of a delete with no
 * tombstone, and it costs a second delete rather than anything lost.
 */
export async function deleteSharedRun(client: SupabaseClient, runId: string): Promise<void> {
  const res = await client
    .schema(SCHEMA)
    .from(TABLE)
    .delete()
    .eq("run_id", runId)
    .select("telemetry_object");
  if (res.error) throw new Error(`delete shared run: ${res.error.message}`);
  const objects = ((res.data ?? []) as { telemetry_object: string | null }[])
    .map((r) => r.telemetry_object)
    .filter((o): o is string => !!o);
  if (!objects.length) return;
  const rm = await client.storage.from(BUCKET).remove(objects);
  if (rm.error) throw new Error(`delete shared telemetry: ${rm.error.message}`);
}

/** A shared run's telemetry, for bringing it onto this machine. */
export async function fetchSharedTelemetry(
  client: SupabaseClient,
  run: SimRun,
): Promise<string> {
  if (!run.telemetryObject) {
    throw new Error("that run's telemetry was not shared -- only its time was");
  }
  const res = await client.storage.from(BUCKET).download(run.telemetryObject);
  if (res.error) throw new Error(`download telemetry: ${res.error.message}`);
  // The suffix says which it is. Objects uploaded before compression, and
  // any written where `CompressionStream` was missing, are plain.
  if (!run.telemetryObject.endsWith(".gz")) return await res.data.text();
  const stream = res.data.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}
