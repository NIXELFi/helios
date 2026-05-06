import { describe, it, expect } from "vitest";
import { buildSessionGroups } from "../../src/xy-plot/data-pipeline";
import type { OverlaySession } from "../../src/types";

function fakeSession(): OverlaySession {
  return {
    id: "s", label: "s", color: "#FFC627",
    range: { startUs: 0, endUs: 4 },
    isPrimary: true,
    slice: {
      time: BigInt64Array.from([0n, 1n, 2n, 3n, 4n]),
      data: new Map<string, Float64Array>([
        ["throttle", Float64Array.from([10, 20, 30, 40, 50])],
        ["rpm",      Float64Array.from([1000, 2000, 3000, 4000, 5000])],
        ["gear",     Float64Array.from([1, 1, 2, 2, 3])],
      ]),
    },
  };
}

describe("buildSessionGroups", () => {
  it("with no filter / no group-by / no zoom, returns one group per session", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.n).toBe(5);
    expect(out[0]!.groupKey).toBe("");
  });

  it("filter expression drops samples where it is falsy", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      filter: "throttle > 25",
    });
    expect(out[0]!.n).toBe(3);
    expect(Array.from(out[0]!.xs)).toEqual([30, 40, 50]);
  });

  it("group-by produces one group per distinct value, palette-cycled colors", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      groupByChannelId: "gear",
    });
    expect(out).toHaveLength(3);
    const keys = out.map((g) => g.groupKey).sort();
    expect(keys).toEqual(["1", "2", "3"]);
    const colors = new Set(out.map((g) => g.color));
    expect(colors.size).toBe(3);
  });

  it("zoom range clamps samples by timestamp", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      zoomRange: { startUs: 1, endUs: 3 },
    });
    expect(out[0]!.n).toBe(3);
    expect(Array.from(out[0]!.xs)).toEqual([20, 30, 40]);
  });

  it("filter + group-by + zoom together compose correctly", () => {
    const out = buildSessionGroups([fakeSession()], {
      xChannelId: "throttle", yChannelId: "rpm",
      filter: "throttle >= 20",
      groupByChannelId: "gear",
      zoomRange: { startUs: 1, endUs: 4 },
    });
    const byGear = new Map(out.map((g) => [g.groupKey, Array.from(g.xs)]));
    expect(byGear.get("1")).toEqual([20]);
    expect(byGear.get("2")).toEqual([30, 40]);
    expect(byGear.get("3")).toEqual([50]);
  });
});
