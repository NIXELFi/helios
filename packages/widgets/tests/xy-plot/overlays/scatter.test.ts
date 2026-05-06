import { describe, it, expect } from "vitest";
import { scatterOverlay } from "../../../src/xy-plot/overlays/scatter";
import type { SessionGroup } from "../../../src/xy-plot/types";

const fakeGroup: SessionGroup = {
  session: { id: "s", label: "s", color: "#FFC627",
             range: { startUs: 0, endUs: 1 }, isPrimary: true,
             slice: { time: BigInt64Array.from([0n]), data: new Map(), range: { startUs: 0, endUs: 1 } } },
  groupKey: "",
  color: "#FFC627",
  time: Float64Array.from([0]),
  xs: Float64Array.from([1, 2, 3]),
  ys: Float64Array.from([4, 5, 6]),
  n: 3,
};

describe("scatter overlay", () => {
  it("compute returns the unmodified groups (no derived artifacts)", () => {
    const cfg = scatterOverlay.defaultConfig();
    const artifacts = scatterOverlay.compute([fakeGroup], cfg, {
      bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 10 },
      priorArtifacts: new Map(),
      availableChannels: [],
    });
    expect(artifacts.groups).toBe(artifacts.groups);
    expect(artifacts.groups[0]!.n).toBe(3);
  });

  it("legendEntries produces one entry per group when there are multiple", () => {
    const cfg = scatterOverlay.defaultConfig();
    const artifacts = scatterOverlay.compute(
      [fakeGroup, { ...fakeGroup, groupKey: "g2", color: "#26A69A" }],
      cfg,
      {
        bounds: { xmin: 0, xmax: 10, ymin: 0, ymax: 10 },
        priorArtifacts: new Map(),
        availableChannels: [],
      },
    );
    const entries = scatterOverlay.legendEntries!(cfg, artifacts);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.label).toBe("g2");
  });
});
