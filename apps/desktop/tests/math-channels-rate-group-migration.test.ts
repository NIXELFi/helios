import { describe, it, expect } from "vitest";
import { ChannelStore, RateGroup } from "@helios/store";
import type { ChannelMeta } from "@helios/store";
import { applyMathChannels, type MathChannel } from "../src/lib/math-channels";

/** Regression: when a math channel's dependencies move between rate groups
 *  (e.g. a user rewires the expression from a 100Hz channel to a 50Hz channel),
 *  the previously-added math channel record must be evicted from its old rate
 *  group. Otherwise stale data lingers there and slice() returns the wrong
 *  column. */

const meta = (id: string, sample_rate_hz: number): ChannelMeta => ({
  id, display_name: id, units: "", group: "test", color: "#fff",
  decimals: 2, data_type: "f64", source: "test", sample_rate_hz,
});

function makeStore() {
  const store = new ChannelStore();
  // 100 Hz group: 4 samples
  const rgFast = RateGroup.fromColumns({
    id: "100hz", nominalRateHz: 100,
    time: BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n]),
    columns: new Map([
      ["fast.rpm", Float64Array.from([1000, 2000, 3000, 4000])],
    ]),
  });
  store.addRateGroup(rgFast, [meta("fast.rpm", 100)]);
  // 50 Hz group: 2 samples
  const rgSlow = RateGroup.fromColumns({
    id: "50hz", nominalRateHz: 50,
    time: BigInt64Array.from([0n, 20_000n]),
    columns: new Map([
      ["slow.temp", Float64Array.from([88, 92])],
    ]),
  });
  store.addRateGroup(rgSlow, [meta("slow.temp", 50)]);
  return store;
}

describe("applyMathChannels rate-group migration", () => {
  it("evicts stale column when expression moves to a different rate group", () => {
    const store = makeStore();

    // First pass: math channel depends on fast.rpm → lands in 100hz group.
    const v1: MathChannel = {
      id: "math.foo", display_name: "foo", units: "", decimals: 2,
      color: "#fff", group: "Math",
      expression: "fast.rpm * 2",
    };
    const r1 = applyMathChannels(store, [v1]);
    expect(r1.errors.size).toBe(0);
    expect(store.groupOf("math.foo")?.id).toBe("100hz");
    expect(store.groupOf("math.foo")?.columns.has("math.foo")).toBe(true);

    // Second pass: same id, expression now references slow.temp → should
    // migrate to the 50hz group, and the 100hz group must NOT keep an entry.
    const v2: MathChannel = { ...v1, expression: "slow.temp + 1" };
    const r2 = applyMathChannels(store, [v2]);
    expect(r2.errors.size).toBe(0);
    expect(store.groupOf("math.foo")?.id).toBe("50hz");

    // The new column must be the right length (matches 50hz group).
    const slowRg = store.groups().find((g) => g.id === "50hz")!;
    expect(slowRg.columns.get("math.foo")?.length).toBe(slowRg.time.length);

    // The old column in the 100hz group must be gone — this is the bug
    // we're guarding against.
    const fastRg = store.groups().find((g) => g.id === "100hz")!;
    expect(fastRg.columns.has("math.foo")).toBe(false);
  });

  it("does not remove the column when recomputing in the same rate group", () => {
    const store = makeStore();
    const v1: MathChannel = {
      id: "math.bar", display_name: "bar", units: "", decimals: 2,
      color: "#fff", group: "Math",
      expression: "fast.rpm + 1",
    };
    applyMathChannels(store, [v1]);
    const v2: MathChannel = { ...v1, expression: "fast.rpm + 100" };
    const r = applyMathChannels(store, [v2]);
    expect(r.errors.size).toBe(0);
    expect(store.groupOf("math.bar")?.id).toBe("100hz");
    const fastRg = store.groups().find((g) => g.id === "100hz")!;
    expect(fastRg.columns.get("math.bar")?.[0]).toBe(1100);
  });
});
