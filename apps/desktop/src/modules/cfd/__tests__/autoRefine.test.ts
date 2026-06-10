import { describe, it, expect } from "vitest";

import { improvedEnough, MIN_REL_IMPROVEMENT } from "../lib/autoRefine";
import { buildSensitivityTsv } from "../lib/export/buildCsv";

describe("improvedEnough", () => {
  it("first round (no prior best) always continues", () => {
    expect(improvedEnough(null, 42, "maximize")).toBe(true);
  });

  it("is direction-aware with a 0.5% relative floor", () => {
    // maximize: 100 → 101 = +1% gain → continue; 100 → 100.2 = +0.2% → stop.
    expect(improvedEnough(100, 101, "maximize")).toBe(true);
    expect(improvedEnough(100, 100.2, "maximize")).toBe(false);
    // minimize: lap time 50 → 49.5 = 1% better → continue; 50 → 50.4 worse → stop.
    expect(improvedEnough(50, 49.5, "minimize")).toBe(true);
    expect(improvedEnough(50, 50.4, "minimize")).toBe(false);
    expect(MIN_REL_IMPROVEMENT).toBeCloseTo(0.005, 6);
  });
});

describe("buildSensitivityTsv", () => {
  it("emits one row per tunable with rho, n, and the active metric", () => {
    const tsv = buildSensitivityTsv(
      [{ label: "runner_length", value: -0.8012, n: 128 }, { label: "plenum_volume_l", value: 0.31 }],
      "total pts",
    );
    const lines = tsv.split("\n");
    expect(lines[0]).toBe("parameter\tspearman_rho\tn\tmetric");
    expect(lines[1]).toBe("runner_length\t-0.8012\t128\ttotal pts");
    expect(lines[2]).toBe("plenum_volume_l\t0.3100\t\ttotal pts");
  });
});
