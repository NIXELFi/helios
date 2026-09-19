/* `pushRuns` against an in-memory PostgREST and storage.
 *
 * The fake is small and literal about the one thing that matters: PostgREST's
 * upsert writes EVERY key in the payload, as `insert ... on conflict do update
 * set col = excluded.col`, so a column this side did not mean to send is a
 * column the server overwrites. Both of the bugs this file guards against were
 * found by driving the real module through exactly this fake, in the state the
 * live table was actually in: fifty-four rows gone stale at once, three of
 * them pointing at nineteen megabytes of laps. */
import { describe, it, expect } from "vitest";

import { pushRuns, telemetryToKeep } from "../share";
import type { SimRun } from "../../api";

const ME = "5c438ca3-9dee-45a7-bf15-4be3b98b5712";

function run(id: string, best: number | null, hour: number, over: Partial<SimRun> = {}): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 99.2, runId: id, dir: `C:/x/${id}`,
    telemetryPath: `C:/x/${id}/telemetry.csv`, telemetryBytes: 1000, driver: "Nick",
    driverId: ME, session: null, track: "autocross", trackName: "Autocross",
    startedAt: `2026-09-19T${String(hour).padStart(2, "0")}:00:00Z`, finishedReason: "finished",
    profile: "wheel", detectedInput: "wheel", device: null, physics: null, simVersion: null,
    synthetic: false, samples: 4000, assists: { traction: false, abs: false, autoShift: false },
    laps: [],
    stats: {
      durationS: 40, distanceM: 680, laps: best == null ? 0 : 1, bestLapS: best, bestLapRawS: best,
      bestLapNumber: 1, bestSectors: [], theoreticalBestS: null, totalCones: 0, totalOffCourse: 0,
      peakSpeedKph: 0, peakRpm: 0, peakLatG: 0, peakBrakeG: 0, peakAccelG: 0, avgSpeedMps: 0,
      fullThrottleFrac: 0, brakingFrac: 0, offTrackS: 0, ffbClippedFrac: 0,
    },
    ...over,
  } as SimRun;
}

/** Server state, shared across every "machine" that syncs against it. */
function server() {
  const table = new Map<string, Record<string, unknown>>();
  const bucket = new Map<string, number>();
  const removed: string[] = [];

  const client = (userId: string) => {
    const query = () => {
      let filter = (_r: Record<string, unknown>) => true;
      const chain = {
        select() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        eq(col: string, v: unknown) {
          const prev = filter;
          filter = (r) => prev(r) && r[col] === v;
          return chain;
        },
        then(resolve: (v: unknown) => unknown) {
          return resolve({ data: [...table.values()].filter(filter), error: null });
        },
        upsert(payload: Record<string, unknown>[]) {
          for (const p of payload) {
            const id = p.run_id as string;
            // Every key in the payload lands; the trigger stamps identity.
            table.set(id, { ...(table.get(id) ?? {}), ...p, user_id: userId });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(col: string, v: unknown) {
              for (const [id, r] of table) if (r[col] === v) table.set(id, { ...r, ...patch });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
      return chain;
    };
    const storage = {
      upload(name: string, body: Uint8Array) {
        bucket.set(name, body.length);
        return Promise.resolve({ error: null });
      },
      remove(names: string[]) {
        for (const n of names) { bucket.delete(n); removed.push(n); }
        return Promise.resolve({ error: null });
      },
      list(prefix: string) {
        const data = [...bucket.keys()]
          .filter((k) => k.startsWith(`${prefix}/`))
          .map((k) => ({ name: k.slice(prefix.length + 1), id: k, created_at: "2026-09-19T00:00:00Z" }));
        return Promise.resolve({ data, error: null });
      },
    };
    return {
      schema() { return { from() { return query(); } }; },
      storage: { from() { return storage; } },
    } as never;
  };

  const sync = (userId: string, local: SimRun[]) =>
    pushRuns(client(userId), userId, local, async () => csv);
  const objectOf = (id: string) => table.get(id)?.telemetry_object ?? null;
  return { table, bucket, removed, sync, objectOf };
}

const csv = new TextEncoder().encode(
  "time_s,a\n" + Array.from({ length: 200 }, (_, i) => `${(i / 100).toFixed(2)},${i}`).join("\n") + "\n",
);

// The rig: five autocross runs. Best two are b (41) and d (42); the most
// recent three are e, d, c. So b, c, d and e keep their laps and a does not.
const RIG = [run("a", 44, 1), run("b", 41, 2), run("c", 43, 3), run("d", 42, 4), run("e", 45, 5)];

describe("re-pushing a run that has gone stale", () => {
  it("leaves the pointer to its lap alone", async () => {
    const s = server();
    let r = await s.sync(ME, RIG);
    expect(r.pushed).toBe(5);
    expect(r.telemetryPushed).toBe(4);
    const before = ["b", "c", "d", "e"].map((id) => s.objectOf(id));
    expect(before.every(Boolean)).toBe(true);

    // The live state: a column added after every run was pushed, null on all
    // of them, so `rowStamp` says every row is stale and every row goes up
    // again.
    for (const row of s.table.values()) row.profile = null;
    r = await s.sync(ME, RIG);
    expect(r.pushed).toBe(5);

    // Nothing was uploaded again, because nothing needed to be: the rows
    // still say where each lap is, and each lap is still there.
    expect(r.telemetryPushed).toBe(0);
    expect(["b", "c", "d", "e"].map((id) => s.objectOf(id))).toEqual(before);
    for (const object of before) expect(s.bucket.has(object as string)).toBe(true);
    expect(s.removed).toEqual([]);
  });
});

describe("what the sweep collects", () => {
  it("an object that no row points at", async () => {
    const s = server();
    await s.sync(ME, RIG);
    // What the stale re-push left behind before it was fixed: the row now
    // points at a re-uploaded copy under the other suffix and the original
    // sits beside it, reachable by nothing. And a lap whose row is simply
    // gone. (Whether this environment gzips decides which suffix is which;
    // the sweep must not care.)
    const current = s.objectOf("b") as string;
    const twin = current.endsWith(".gz") ? `${ME}/b.csv` : `${ME}/b.csv.gz`;
    s.bucket.set(twin, 1_706_194);
    s.bucket.set(`${ME}/deleted-run.csv.gz`, 5_465_734);

    const r = await s.sync(ME, RIG);
    expect(r.telemetrySwept).toBe(2);
    expect(s.bucket.has(twin)).toBe(false);
    expect(s.bucket.has(`${ME}/deleted-run.csv.gz`)).toBe(false);
    // ...and only those. The laps the rows point at are untouched.
    expect(s.bucket.has(s.objectOf("b") as string)).toBe(true);
    expect(s.bucket.size).toBe(4);
    expect(r.telemetryPruned).toBe(0);
  });

  it("is not something another machine is still in the middle of marking", async () => {
    const s = server();
    await s.sync(ME, RIG);
    // The rig has just uploaded a new personal best and is one round trip
    // away from pointing its row at it. The laptop syncs in that gap.
    const pb = run("pb", 39, 6);
    s.table.set("pb", {
      run_id: "pb", user_id: ME, track: "autocross", best_lap_s: 39, laps: 1, total_cones: 0,
      assists: pb.assists, synthetic: false, format_version: 3, profile: "wheel",
      detected_input: "wheel", started_at: pb.startedAt, stats: pb.stats, laps_detail: [],
      telemetry_object: null, telemetry_bytes: null,
    });
    s.bucket.set(`${ME}/pb.csv.gz`, 900_000);

    const r = await s.sync(ME, [run("laptop-1", 60, 9)]);
    expect(s.bucket.has(`${ME}/pb.csv.gz`)).toBe(true);
    expect(r.telemetrySwept).toBe(0);
  });

  it("only what this module wrote", async () => {
    const s = server();
    await s.sync(ME, RIG);
    s.bucket.set(`${ME}/notes.txt`, 12);
    const r = await s.sync(ME, RIG);
    expect(r.telemetrySwept).toBe(0);
    expect(s.bucket.has(`${ME}/notes.txt`)).toBe(true);
  });
});

describe("the same driver on a second machine", () => {
  it("judges the rule over everything the driver has, not over this disk", async () => {
    const s = server();
    await s.sync(ME, RIG);
    expect(s.bucket.size).toBe(4);

    // A laptop holding one run of theirs. On its own that run is the only
    // thing on its board; against the rig's five it is merely the newest.
    const laptop = [run("laptop-1", 60, 9)];
    expect([...telemetryToKeep(laptop, ME)]).toEqual(["laptop-1"]);
    const cObject = s.objectOf("c") as string;

    const r = await s.sync(ME, laptop);
    // Best two are still b and d; recent three are now laptop-1, e and d.
    // c falls out. That is the rule working, and it is ONE lap, not four.
    expect(r.telemetryPruned).toBe(1);
    expect(s.removed).toEqual([cObject]);
    expect(s.objectOf("c")).toBeNull();
    for (const id of ["b", "d", "e", "laptop-1"]) {
      expect(s.objectOf(id)).not.toBeNull();
      expect(s.bucket.has(s.objectOf(id) as string)).toBe(true);
    }
  });

  it("converges rather than ping-ponging", async () => {
    const s = server();
    await s.sync(ME, RIG);
    await s.sync(ME, [run("laptop-1", 60, 9)]);
    const objects = [...s.bucket.keys()].sort();

    // The rig syncs again. It sees the laptop's run in the rows, computes the
    // same keep set, and has nothing to do -- and neither will the laptop.
    const r = await s.sync(ME, RIG);
    expect(r.pushed).toBe(0);
    expect(r.telemetryPushed).toBe(0);
    expect(r.telemetryPruned).toBe(0);
    expect(r.telemetrySwept).toBe(0);
    expect([...s.bucket.keys()].sort()).toEqual(objects);
  });

  it("counts a run only the server holds when deciding what to keep", () => {
    // The row, dressed as a run. It is a run of mine and it is not on this
    // disk; the rule has to see it or the two machines disagree.
    const theirs = run("on-the-rig", 40, 2, { remote: true, dir: "", telemetryPath: "" });
    const keep = telemetryToKeep([run("here", 45, 9), theirs], ME);
    expect(keep.has("on-the-rig")).toBe(true);
  });
});
