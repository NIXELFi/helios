import { describe, it, expect } from "vitest";
import { formulaOverlay } from "../../../src/xy-plot/overlays/formula";

describe("formula overlay", () => {
  it("samples a parsable expression across the bounds", () => {
    const cfg = { ...formulaOverlay.defaultConfig(), expression: "2 * x + 1" };
    const artifacts = formulaOverlay.compute([], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 30 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.error).toBeNull();
    expect(artifacts.sampleY[0]).toBeCloseTo(1, 6);
    expect(artifacts.sampleY[artifacts.sampleY.length - 1]).toBeCloseTo(21, 6);
  });

  it("returns an error for an unparseable expression", () => {
    const cfg = { ...formulaOverlay.defaultConfig(), expression: "2 * +" };
    const artifacts = formulaOverlay.compute([], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 30 },
      priorArtifacts: new Map(), availableChannels: [],
    });
    expect(artifacts.error).not.toBeNull();
    expect(artifacts.sampleY).toHaveLength(0);
  });
});
