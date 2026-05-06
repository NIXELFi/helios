import { describe, it, expect } from "vitest";
import { binsOverlay } from "../../../src/xy-plot/overlays/bins";
import type { SessionGroup } from "../../../src/xy-plot/types";

const group: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map(), range: { startUs: 0, endUs: 1 } } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 0, 0, 0, 0, 0]),
  xs: Float64Array.from([0, 0.1, 5, 5.1, 10, 9.9]),
  ys: Float64Array.from([1, 3,   5, 7,   9, 11]),
  n: 6,
};

describe("bins overlay", () => {
  it("mean statistic produces one yStat per non-empty bin", () => {
    const cfg = { ...binsOverlay.defaultConfig(), binCount: 3, statistic: "mean" as const };
    const artifacts = binsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 12 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.bins).toHaveLength(3);
    expect(artifacts.bins[0]!.yStat).toBeCloseTo((1 + 3) / 2, 6);
    expect(artifacts.bins[1]!.yStat).toBeCloseTo((5 + 7) / 2, 6);
    expect(artifacts.bins[2]!.yStat).toBeCloseTo((9 + 11) / 2, 6);
  });

  it("p25-p75 fills yLow/yHigh per bin", () => {
    const cfg = { ...binsOverlay.defaultConfig(), binCount: 3, statistic: "p25-p75" as const };
    const artifacts = binsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 12 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.bins[0]!.yLow).toBeDefined();
    expect(artifacts.bins[0]!.yHigh).toBeDefined();
  });
});
