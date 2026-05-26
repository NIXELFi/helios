import { describe, expect, it } from "vitest";
import { COLORMAPS, sampleColormap } from "../colormaps";

describe("colormaps", () => {
  it("ships RdBu_r, inferno, viridis as 256-entry LUTs", () => {
    for (const name of ["RdBu_r", "inferno", "viridis"] as const) {
      const lut = COLORMAPS[name];
      expect(lut).toHaveLength(256);
      for (const rgb of lut) {
        expect(rgb).toHaveLength(3);
        for (const c of rgb) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("RdBu_r is blue at 0, white-ish near 0.5, red at 1", () => {
    const low = sampleColormap("RdBu_r", 0);
    const mid = sampleColormap("RdBu_r", 0.5);
    const high = sampleColormap("RdBu_r", 1);
    expect(low[2]).toBeGreaterThan(low[0]);
    expect(high[0]).toBeGreaterThan(high[2]);
    expect(mid[0] + mid[1] + mid[2]).toBeGreaterThan(500);
  });

  it("inferno is dark at 0 and bright at 1", () => {
    const low = sampleColormap("inferno", 0);
    const high = sampleColormap("inferno", 1);
    expect(low[0] + low[1] + low[2]).toBeLessThan(60);
    expect(high[0] + high[1] + high[2]).toBeGreaterThan(500);
  });

  it("viridis is purple at 0 and yellow at 1", () => {
    const low = sampleColormap("viridis", 0);
    const high = sampleColormap("viridis", 1);
    expect(low[2]).toBeGreaterThan(low[1]);
    expect(high[0] + high[1]).toBeGreaterThan(2 * high[2]);
  });

  it("clamps out-of-range inputs", () => {
    expect(sampleColormap("viridis", -1)).toEqual(sampleColormap("viridis", 0));
    expect(sampleColormap("viridis", 2)).toEqual(sampleColormap("viridis", 1));
    expect(sampleColormap("viridis", Number.NaN)).toEqual(sampleColormap("viridis", 0));
  });
});
