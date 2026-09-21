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

import { deleteSharedRun, fetchSharedRuns, pushRuns, telemetryToKeep } from "../share";
import type { SimRun } from "../../api";

const ME = "5c438ca3-9dee-45a7-bf15-4be3b98b5712";

function run(id: string, best: number | null, hour: number, over: Partial<SimRun> = {}): SimRun {
  return {
    formatVersion: 3, sampleRateHz: 99.2, runId: id, dir: `C:/x/${id}`,
    telemetryPath: `C:/x/${id}/telemetry.csv`, telemetryBytes: 1000, driver: "Nick",
    driverId: ME, session: null, track: "autocross", trackName: "Autocross",
    startedAt: `2026-09-19T${String(hour).padStart(2, "0")}:00:00Z`, finishedReason: "finished",
    // On the course as it is now: see `predatesCourse`. A run with no
    // version from before the courses changed shape is stale by rule, and
    // that case has its own test at the bottom.
    profile: "wheel", detectedInput: "wheel", device: null, physics: null, simVersion: "0.6.0",
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
      let deleting = false;
      // PostgREST's own row cap, which is the whole point of the paging test
      // below: the server truncates at `max-rows` and says nothing about it.
      const MAX_ROWS = 1000;
      let range: { from: number; to: number } | null = null;
      const chain = {
        select() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        range(from: number, to: number) { range = { from, to }; return chain; },
        delete() { deleting = true; return chain; },
        eq(col: string, v: unknown) {
          const prev = filter;
          filter = (r) => prev(r) && r[col] === v;
          return chain;
        },
        then(resolve: (v: unknown) => unknown) {
          let rows = [...table.values()].filter(filter);
          // `delete().select()` hands back what it removed, as PostgREST does.
          if (deleting) for (const r of rows) table.delete(r.run_id as string);
          if (range) {
            // Newest first, the order `fetchSharedRuns` asks for.
            rows.sort((a, b) =>
              String(b.started_at).localeCompare(String(a.started_at)) ||
              String(b.run_id).localeCompare(String(a.run_id)));
            rows = rows.slice(range.from, range.from + Math.min(range.to - range.from + 1, MAX_ROWS));
          }
          return resolve({ data: rows, error: null });
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
  /** Put a row on the server without going through a push. */
  const seed = (row: Record<string, unknown>) => table.set(row.run_id as string, row);
  return { table, bucket, removed, sync, objectOf, client, seed };
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
    // Best three are still b, d and c; recent three are now laptop-1, e and
    // d. Nothing falls out -- c is a best -- and the laptop's lap goes up.
    // That is the rule working over the driver's five-plus-one, not over the
    // one run this disk holds: judged on this disk alone, four would go.
    expect(r.telemetryPruned).toBe(0);
    expect(s.removed).toEqual([]);
    expect(s.objectOf("c")).toBe(cObject);
    for (const id of ["b", "c", "d", "e", "laptop-1"]) {
      expect(s.objectOf(id)).not.toBeNull();
      expect(s.bucket.has(s.objectOf(id) as string)).toBe(true);
    }
    // Three newer runs later the recent three are all the laptop's, and e --
    // recent only, never a best -- is the one lap that falls out. ONE, not
    // four.
    const eObject = s.objectOf("e") as string;
    const r2 = await s.sync(ME, [run("laptop-1", 60, 9), run("laptop-2", 61, 10), run("laptop-3", 62, 11)]);
    expect(r2.telemetryPruned).toBe(1);
    expect(s.removed).toEqual([eObject]);
    expect(s.objectOf("e")).toBeNull();
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

  it("carries the sample count up with the row", async () => {
    // It was left out, so every shared run read "0 samples at 99 Hz".
    const s = server();
    await s.sync(ME, RIG);
    expect((s.table.get("a")?.stats as { samples?: number }).samples).toBe(4000);
  });

  it("counts a run only the server holds when deciding what to keep", () => {
    // The row, dressed as a run. It is a run of mine and it is not on this
    // disk; the rule has to see it or the two machines disagree.
    const theirs = run("on-the-rig", 40, 2, { remote: true, dir: "", telemetryPath: "" });
    const keep = telemetryToKeep([run("here", 45, 9), theirs], ME);
    expect(keep.has("on-the-rig")).toBe(true);
  });
});

describe("taking a run off the board", () => {
  it("removes the row and the lap it pointed at", async () => {
    // There was no way to do this: "Delete for good" removed the directory
    // and the run came straight back from the server, still ranked.
    const s = server();
    await s.sync(ME, RIG);
    const object = s.objectOf("b") as string;
    await deleteSharedRun(s.client(ME), "b");
    expect(s.table.has("b")).toBe(false);
    expect(s.bucket.has(object)).toBe(false);
    expect(s.removed).toEqual([object]);
  });

  it("is content with a run that shared its time only", async () => {
    const s = server();
    await s.sync(ME, RIG);
    expect(s.objectOf("a")).toBeNull();
    await deleteSharedRun(s.client(ME), "a");
    expect(s.table.has("a")).toBe(false);
    expect(s.removed).toEqual([]);
  });
});

// PostgREST truncates a response at its own `max-rows` -- 1000 on this
// project -- and does it silently: no error, no flag, just a thousand rows.
// `fetchSharedRuns` asked for 2000 in one request and believed it had them,
// so past a thousand shared runs the board kept the newest thousand and
// dropped the oldest without saying so. Ordered newest first, the rows it
// dropped were the season's earliest, which is where a driver's first
// personal best lives.
describe("reading a board bigger than the server will send at once", () => {
  it("collects past the cap instead of stopping at it", async () => {
    const s = server();
    for (let i = 0; i < 2300; i++) {
      s.seed({
        run_id: `r${String(i).padStart(4, "0")}`,
        user_id: ME,
        driver: "Nick",
        track: "autocross",
        track_name: "Autocross",
        // Ascending time with the index, so run 0 is the OLDEST -- the one
        // the truncation used to throw away.
        started_at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}Z`,
        best_lap_s: 40 + (i % 10),
        laps: 1,
        total_cones: 0,
        assists: null,
        synthetic: false,
        format_version: 3,
        stats: {},
        laps_detail: [],
        telemetry_object: null,
        telemetry_bytes: null,
      });
    }
    const got = await fetchSharedRuns(s.client(ME));
    expect(got).toHaveLength(2300);
    // No row fetched twice: a page boundary landing inside a tie on
    // `started_at` repeats a row unless something breaks the tie.
    expect(new Set(got.map((r) => r.runId)).size).toBe(2300);
  });

  it("stops at the ceiling it was given", async () => {
    const s = server();
    for (let i = 0; i < 2300; i++) {
      s.seed({
        run_id: `r${String(i).padStart(4, "0")}`, user_id: ME, driver: "Nick",
        track: "autocross", track_name: "Autocross",
        started_at: `2026-09-19T00:00:${String(i % 60).padStart(2, "0")}Z`,
        best_lap_s: 40, laps: 1, total_cones: 0, assists: null, synthetic: false,
        format_version: 3, stats: {}, laps_detail: [], telemetry_object: null,
        telemetry_bytes: null,
      });
    }
    expect(await fetchSharedRuns(s.client(ME), 2000)).toHaveLength(2000);
  });
});

describe("a run from before the course changed shape", () => {
  it("stays on this disk and is not pushed", async () => {
    const S = server();
    // Autocross, driven 2026-09-19 on simulator 0.5.7: the course had no
    // slaloms then. The board was cleared of these on purpose, and a rig that
    // still holds one must not put it back.
    const stale = run("old", 40, 3, { simVersion: "0.5.7" });
    const undated = run("nover", 40, 3, { simVersion: null });
    const fresh = run("new", 41, 3, { startedAt: "2026-09-22T10:00:00Z" });
    const res = await S.sync(ME, [stale, undated, fresh]);
    expect(res.skippedStale).toBe(2);
    expect(res.pushed).toBe(1);
    expect([...S.table.keys()]).toEqual(["new"]);
  });

  it("carries the simulator version up with the row, so the rule can be applied to a shared run", async () => {
    const S = server();
    await S.sync(ME, [run("v", 41, 3)]);
    const rows = await fetchSharedRuns(S.client(ME));
    expect(rows[0]?.simVersion).toBe("0.6.0");
  });
});

describe("a lap the budget job took away", () => {
  /** What `sim.enforce_telemetry_budget` does to one run, server-side. */
  const evict = (s: ReturnType<typeof server>, id: string) => {
    const row = s.table.get(id)!;
    s.bucket.delete(row.telemetry_object as string);
    s.table.set(id, {
      ...row, telemetry_object: null, telemetry_bytes: null,
      evicted_at: "2026-09-21T03:00:00Z",
    });
  };

  it("is not put straight back on the next sync", async () => {
    // Without the tombstone this is an oscillation, not an edge case: the
    // retention rule still wants the lap, the object is gone, so every
    // sign-in re-uploads what the job deleted at three in the morning and the
    // bucket sits at the cap for ever.
    const s = server();
    expect((await s.sync(ME, RIG)).telemetryPushed).toBe(4);
    evict(s, "b");

    const again = await s.sync(ME, RIG);
    expect(again.telemetryPushed).toBe(0);
    expect(s.objectOf("b")).toBeNull();
    expect(again.error).toBeNull();
  });

  it("does not stop the other laps going up", async () => {
    // One evicted run must not look like "telemetry is done" for the rest.
    const s = server();
    await s.sync(ME, [run("a", 44, 1)]);
    s.seed({
      run_id: "b", user_id: ME, track: "autocross", started_at: "2026-09-19T02:00:00Z",
      best_lap_s: 41, laps: 1, total_cones: 0, assists: {}, synthetic: false,
      format_version: 3, profile: "wheel", detected_input: "wheel", stats: {}, laps_detail: [],
      telemetry_object: null, telemetry_bytes: null, evicted_at: "2026-09-21T03:00:00Z",
    });

    const res = await s.sync(ME, [run("a", 44, 1), run("b", 41, 2), run("c", 43, 3)]);
    expect(s.objectOf("b")).toBeNull();
    expect(s.objectOf("c")).toBeTruthy();
    expect(res.telemetryPushed).toBe(1);
  });

  it("goes up again once the tombstone is cleared", async () => {
    // Clearing the column is a deliberate act -- the run panel's doing, or a
    // maintainer's. The rule is "do not put back what was removed on purpose",
    // not "never again".
    const s = server();
    await s.sync(ME, RIG);
    evict(s, "b");
    expect((await s.sync(ME, RIG)).telemetryPushed).toBe(0);

    s.table.set("b", { ...s.table.get("b")!, evicted_at: null });
    expect((await s.sync(ME, RIG)).telemetryPushed).toBe(1);
    expect(s.objectOf("b")).toBeTruthy();
  });
});
