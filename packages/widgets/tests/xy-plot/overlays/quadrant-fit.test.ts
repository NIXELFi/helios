import { describe, it, expect } from "vitest";
import { quadrantFitOverlay } from "../../../src/xy-plot/overlays/quadrant-fit";
import type { SessionGroup } from "../../../src/xy-plot/types";

const group: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map(), range: { startUs: 0, endUs: 1 } } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 0, 0, 0, 0, 0]),
  xs: Float64Array.from([-3, -2, -1, 1, 2, 3]),
  ys: Float64Array.from([3, 2, 1, 2, 4, 6]),
  n: 6,
};

describe("quadrant-fit overlay", () => {
  it("fits each x-sign separately and reports per-quadrant stats", () => {
    const cfg = { ...quadrantFitOverlay.defaultConfig(), kind: { type: "linear" as const } };
    const artifacts = quadrantFitOverlay.compute([group], cfg, {
      bounds: { xmin: -3, xmax: 3, ymin: 0, ymax: 6 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.quadrants.length).toBeGreaterThanOrEqual(2);
    const q1 = artifacts.quadrants.find((q) => q.label === "Q1")!;
    const q2 = artifacts.quadrants.find((q) => q.label === "Q2")!;
    expect(q1.coefficients[1]).toBeCloseTo(2, 4);
    expect(q2.coefficients[1]).toBeCloseTo(-1, 4);
  });
});
