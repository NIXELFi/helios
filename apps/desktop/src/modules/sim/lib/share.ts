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
    samples: 0,
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

function runToRow(run: SimRun): Omit<RunRow, "user_id" | "display_name" | "subteam"> {
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
    stats: { ...run.stats, sampleRateHz: run.sampleRateHz },
    laps_detail: run.laps ?? [],
    telemetry_object: null,
    telemetry_bytes: null,
  };
}

/** Every run the team has shared, newest first. */
export async function fetchSharedRuns(client: SupabaseClient, limit = 2000): Promise<SimRun[]> {
  const res = await client
    .schema(SCHEMA)
    .from(TABLE)
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (res.error) throw new Error(`read shared runs: ${res.error.message}`);
  return (res.data as RunRow[]).map(rowToRun);
}

/** Which of this user's runs are already up there, and what each carries. */
async function sharedIdsFor(
  client: SupabaseClient,
  userId: string,
): Promise<Map<string, string | null>> {
  const res = await client
    .schema(SCHEMA)
    .from(TABLE)
    .select("run_id,telemetry_object")
    .eq("user_id", userId);
  if (res.error) throw new Error(`read shared run ids: ${res.error.message}`);
  const out = new Map<string, string | null>();
  for (const r of res.data as { run_id: string; telemetry_object: string | null }[]) {
    out.set(r.run_id, r.telemetry_object);
  }
  return out;
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
  const mine = runs.filter((r) => r.driverId === userId && !r.remote && !r.synthetic);
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
    pushed: 0, telemetryPushed: 0, telemetryPruned: 0, skippedNotMine: 0, error: null,
  };
  const mine = local.filter((r) => {
    if (r.remote) return false;
    if (r.driverId !== userId) { out.skippedNotMine++; return false; }
    return true;
  });
  if (!mine.length) return out;

  let already: Map<string, string | null>;
  try {
    already = await sharedIdsFor(client, userId);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }

  const wantTelemetry = telemetryToKeep(local, userId);

  // Metadata first, in one round trip. Upsert, because a run that was pushed
  // and then re-read with a newer manifest should update rather than collide.
  const missing = mine.filter((r) => !already.has(r.runId));
  if (missing.length) {
    const res = await client
      .schema(SCHEMA)
      .from(TABLE)
      .upsert(missing.map(runToRow), { onConflict: "run_id" });
    if (res.error) {
      out.error = `share runs: ${res.error.message}`;
      return out;
    }
    out.pushed = missing.length;
  }

  // Then the telemetry for the laps worth watching, one at a time: they are
  // megabytes and a failure on one must not lose the others.
  for (const run of mine) {
    if (!wantTelemetry.has(run.runId)) continue;
    if (already.get(run.runId)) continue;
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
  for (const [runId, object] of already) {
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
      out.telemetryPruned++;
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
  }
  return out;
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
