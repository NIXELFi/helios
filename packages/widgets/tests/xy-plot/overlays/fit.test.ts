import { describe, it, expect } from "vitest";
import { fitOverlay } from "../../../src/xy-plot/overlays/fit";
import type { SessionGroup } from "../../../src/xy-plot/types";

const linearGroup: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map(), range: { startUs: 0, endUs: 1 } } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0, 1, 2, 3, 4]),
  xs: Float64Array.from([0, 1, 2, 3, 4]),
  ys: Float64Array.from([1, 4, 7, 10, 13]),  // y = 3x + 1
  n: 5,
};

describe("fit overlay", () => {
  it("linear fit recovers slope + intercept and samples the curve across the bounds", () => {
    const cfg = { ...fitOverlay.defaultConfig(), kind: { type: "linear" as const } };
    const artifacts = fitOverlay.compute([linearGroup], cfg, {
      bounds: { xmin: 0, xmax: 4, ymin: 1, ymax: 13 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.fits).toHaveLength(1);
    const [fit] = artifacts.fits;
    expect(fit!.coefficients[0]).toBeCloseTo(1, 6);
    expect(fit!.coefficients[1]).toBeCloseTo(3, 6);
    expect(fit!.rSquared).toBeCloseTo(1, 6);
    expect(fit!.sampleX[0]).toBeCloseTo(0, 6);
    expect(fit!.sampleX[fit!.sampleX.length - 1]).toBeCloseTo(4, 6);
  });

  it("legendEntries reports kind + R² rounded to 3 decimals", () => {
    const cfg = { ...fitOverlay.defaultConfig(), kind: { type: "linear" as const } };
    const artifacts = fitOverlay.compute([linearGroup], cfg, {
      bounds: { xmin: 0, xmax: 4, ymin: 1, ymax: 13 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    const entries = fitOverlay.legendEntries!(cfg, artifacts);
    expect(entries[0]!.label).toMatch(/linear.*R².*1\.000/);
  });
});
