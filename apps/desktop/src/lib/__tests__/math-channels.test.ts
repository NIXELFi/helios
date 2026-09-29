/** math-channels.ts: persisted-blob sanitising (a stored bad value must not
 *  freeze boot) and the incremental computeMathChannelsUpdate path. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelStore, RateGroup, type ChannelMeta } from "@helios/store";
import {
  type MathChannel, computeMathChannelsUpdate, loadMathChannels, saveMathChannels,
  sanitizeMathChannels, MAX_EXPRESSION_LENGTH,
} from "../math-channels";

function mc(id: string, expression: string): MathChannel {
  return { id, display_name: id, units: "", decimals: 2, color: "#fff", group: "Math", expression };
}

function makeStore(n = 200): ChannelStore {
  const time = new BigInt64Array(n);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { time[i] = BigInt(i * 10_000); x[i] = i; }
  const meta: ChannelMeta = {
    id: "a.x", display_name: "x", units: "", group: "A", color: "#fff", decimals: 2,
    data_type: "f64", source: "csv", sample_rate_hz: 100,
  };
  const store = new ChannelStore();
  store.addRateGroup(
    RateGroup.fromColumns({ id: "g100", nominalRateHz: 100, time, columns: new Map([["a.x", x]]) }),
    [meta],
  );
  return store;
}

function col(store: ChannelStore, id: string): Float64Array | undefined {
  return store.groupOf(id)?.columns.get(id);
}

describe("sanitizeMathChannels / loadMathChannels", () => {
  beforeEach(() => localStorage.clear());

  it("drops malformed entries, dedupes ids, clamps decimals, coerces fields", () => {
    const out = sanitizeMathChannels([
      null, 42, "x", { id: 5, expression: "1" }, { id: "no_expr" },
      { id: "long", expression: "1+".repeat(MAX_EXPRESSION_LENGTH) + "1" },
      { id: "ok", expression: "a.x * 2", decimals: 1e9, min: "3", max: 10, warn: NaN, units: 7 },
      { id: "ok", expression: "dup" },
      { id: "neg", expression: "1", decimals: -4.2 },
    ]);
    expect(out.map((c) => c.id)).toEqual(["ok", "neg"]);
    expect(out[0]!.decimals).toBe(6);
    expect(out[0]!.max).toBe(10);
    expect(out[0]!.min).toBeUndefined();
    expect(out[0]!.warn).toBeUndefined();
    expect(out[0]!.units).toBe("");
    expect(out[1]!.decimals).toBe(0);
    expect(sanitizeMathChannels({ not: "an array" })).toEqual([]);
  });

  it("loadMathChannels sanitises the stored blob", () => {
    localStorage.setItem("helios.math-channels.v1", JSON.stringify({
      version: 1, channels: [{ id: "m", expression: "1", decimals: 500 }, "junk"],
    }));
    const loaded = loadMathChannels();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.decimals).toBe(6);
  });

  it("a stored huge smooth window applies in bounded time (all-NaN, no freeze)", () => {
    saveMathChannels([mc("m.s", "smooth(a.x, 1e12)")]);
    const store = makeStore(100_000);
    const t0 = performance.now();
    const { errors } = computeMathChannelsUpdate(
      [{ id: "s", store, laps: null }], [], loadMathChannels(),
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(errors.get("s")!.size).toBe(0);
    expect(col(store, "m.s")!.every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("computeMathChannelsUpdate", () => {
  it("incremental edit of the last channel matches a full re-apply", () => {
    const a = mc("m.a", "a.x * 2");
    const b = mc("m.b", "m.a + 1");
    const c = mc("m.c", "bogus_channel");
    const inc = makeStore();
    const full = makeStore();
    const s1 = [{ id: "s", store: inc, laps: null }];
    const s2 = [{ id: "s", store: full, laps: null }];
    const r0 = computeMathChannelsUpdate(s1, [], [a, b, c]);
    computeMathChannelsUpdate(s2, [], [a, b, c]);
    expect(r0.errors.get("s")!.has("m.c")).toBe(true);

    const b2 = { ...b, expression: "m.a + 5" };
    const spy = vi.spyOn(inc, "removeChannel");
    const r1 = computeMathChannelsUpdate(s1, [a, b, c], [a, b2, c], r0.errors);
    // Only the changed channel and its successors are touched.
    expect(spy.mock.calls.map((x) => x[0]).sort()).toEqual(["m.b", "m.c"]);
    const rf = computeMathChannelsUpdate(s2, [a, b, c], [a, b2, c]);
    expect([...r1.errors.get("s")!]).toEqual([...rf.errors.get("s")!]);
    for (const id of ["m.a", "m.b"]) expect(col(inc, id)).toEqual(col(full, id));
    expect(col(inc, "m.b")![3]).toBe(3 * 2 + 5);
  });

  it("keeps prefix errors and handles a rename of an edited channel", () => {
    const bad = mc("m.bad", "nope");
    const a = mc("m.a", "a.x");
    const store = makeStore();
    const s = [{ id: "s", store, laps: null }];
    const r0 = computeMathChannelsUpdate(s, [], [bad, a]);
    const a2 = { ...a, id: "m.renamed" };
    const r1 = computeMathChannelsUpdate(s, [bad, a], [bad, a2], r0.errors);
    expect(r1.errors.get("s")!.has("m.bad")).toBe(true);
    expect(col(store, "m.a")).toBeUndefined();
    expect(col(store, "m.renamed")).toBeDefined();
  });

  it("falls back to a full re-apply without prevErrors", () => {
    const a = mc("m.a", "a.x");
    const b = mc("m.b", "a.x");
    const store = makeStore();
    const s = [{ id: "s", store, laps: null }];
    computeMathChannelsUpdate(s, [], [a, b]);
    const spy = vi.spyOn(store, "removeChannel");
    computeMathChannelsUpdate(s, [a, b], [a, { ...b, expression: "1" }]);
    expect(spy.mock.calls.map((x) => x[0]).sort()).toEqual(["m.a", "m.b"]);
  });
});
