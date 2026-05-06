import { describe, it, expect } from "vitest";
import { statsOverlay } from "../../../src/xy-plot/overlays/stats";
import type { SessionGroup } from "../../../src/xy-plot/types";

const group: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map(), range: { startUs: 0, endUs: 1 } } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 1, 2, 3]),
  xs: Float64Array.from([1, 2, 3, 4]),
  ys: Float64Array.from([2, 4, 6, 8]),
  n: 4,
};

describe("stats overlay", () => {
  it("computes count, means, stddevs, correlation", () => {
    const cfg = statsOverlay.defaultConfig();
    const a = statsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 5, ymin: 0, ymax: 10 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(a.count).toBe(4);
    expect(a.meanX).toBeCloseTo(2.5, 6);
    expect(a.meanY).toBeCloseTo(5, 6);
    expect(a.correlation).toBeCloseTo(1, 6);
  });

  it("reads R² from a referenced fit overlay's prior artifact", () => {
    const cfg = { ...statsOverlay.defaultConfig(), fitOverlayId: "fit-1",
      show: { ...statsOverlay.defaultConfig().show, fitRSquared: true } };
    const fakeFitArtifacts = {
      fits: [{ rSquared: 0.987, coefficients: [1, 2], groupKey: "",
               color: "#fff", residualStd: 0,
               sampleX: new Float64Array(0), sampleY: new Float64Array(0) }],
      warnings: [],
    };
    const a = statsOverlay.compute([group], cfg, {
      bounds: { xmin: 0, xmax: 5, ymin: 0, ymax: 10 },
      priorArtifacts: new Map([["fit-1", fakeFitArtifacts]]),
      availableChannels: [],
    });
    expect(a.fitRSquared).toBeCloseTo(0.987, 3);
  });
});
