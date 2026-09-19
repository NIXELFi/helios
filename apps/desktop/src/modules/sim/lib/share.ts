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

import { isRankable, runBest, type SimRun } from "../api";

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
    profile: null,
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

/** Which of this user's runs are already up there. Ids only; it is a diff. */
async function sharedIdsFor(client: SupabaseClient, userId: string): Promise<Set<string>> {
  const res = await client
    .schema(SCHEMA)
    .from(TABLE)
    .select("run_id,telemetry_object")
    .eq("user_id", userId);
  if (res.error) throw new Error(`read shared run ids: ${res.error.message}`);
  const out = new Set<string>();
  for (const r of res.data as { run_id: string; telemetry_object: string | null }[]) {
    out.add(r.telemetry_object ? `${r.run_id}+tel` : r.run_id);
  }
  return out;
}

/**
 * The runs of this driver's that deserve their telemetry shared.
 *
 * Their best ranked lap on each course, and only that. A personal best is the
 * lap somebody else would actually want to watch; the twelve attempts around
 * it are not, and uploading them turns a practice session into a bill.
 */
export function telemetryWorthSharing(runs: SimRun[], userId: string): Set<string> {
  const best = new Map<string, SimRun>();
  for (const r of runs) {
    if (r.driverId !== userId || r.remote) continue;
    if (!isRankable(r)) continue;
    const t = runBest(r);
    if (t == null) continue;
    const cur = best.get(r.track);
    if (!cur || t < (runBest(cur) as number)) best.set(r.track, r);
  }
  return new Set([...best.values()].map((r) => r.runId));
}

export interface SyncResult {
  pushed: number;
  telemetryPushed: number;
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
  const out: SyncResult = { pushed: 0, telemetryPushed: 0, skippedNotMine: 0, error: null };
  const mine = local.filter((r) => {
    if (r.remote) return false;
    if (r.driverId !== userId) { out.skippedNotMine++; return false; }
    return true;
  });
  if (!mine.length) return out;

  let already: Set<string>;
  try {
    already = await sharedIdsFor(client, userId);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }

  const wantTelemetry = telemetryWorthSharing(local, userId);

  // Metadata first, in one round trip. Upsert, because a run that was pushed
  // and then re-read with a newer manifest should update rather than collide.
  const missing = mine.filter((r) => !already.has(r.runId) && !already.has(`${r.runId}+tel`));
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
    if (already.has(`${run.runId}+tel`)) continue;
    try {
      const body = await readTelemetry(run);
      if (!body || !body.length) continue;
      const object = `${userId}/${run.runId}.csv`;
      const up = await client.storage
        .from(BUCKET)
        .upload(object, body, { contentType: "text/csv", upsert: true });
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
  return await res.data.text();
}
