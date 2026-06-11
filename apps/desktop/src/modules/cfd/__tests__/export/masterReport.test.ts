// Master engineering report builder: section structure, scoping, dyno
// validation, knock flags. Pure HTML assertions — no DOM.

import { describe, it, expect } from "vitest";

import { buildMasterReportHtml } from "../../lib/export/masterReport";
import { REFERENCE_2026 } from "../../lib/performance";
import { makeSweepStudy, makeSweepPoint, makeOptimizationStudy, makeTrial } from "../fakes/study";

const sweep = makeSweepStudy({
  id: "sw1",
  name: "baseline sweep",
  dynoRef: { label: "team-dyno.csv", points: [{ rpm: 10000, powerKw: 60, torqueNm: null }] },
});
const opt = makeOptimizationStudy({
  id: "op1",
  trials: [
    makeTrial({
      trialIdx: 0, status: "done", objectiveValue: 60,
      parameterValues: { runner_length: 0.25, plenum_volume_l: 1.2 },
      sweepPoints: [makeSweepPoint({ rpm: 9000, lastCycle: { knockIntegral: 1.4 } })],
    }),
    makeTrial({
      trialIdx: 1, status: "done", objectiveValue: 64,
      parameterValues: { runner_length: 0.31, plenum_volume_l: 1.6 },
      sweepPoints: [makeSweepPoint({ rpm: 9000, lastCycle: { knockIntegral: 0.5 } })],
    }),
  ],
});

const input = {
  generatedAt: "2026-06-09T20:00:00Z",
  studies: { sw1: sweep, op1: opt },
  vehicleConfig: null,
  referenceBaseline: REFERENCE_2026,
};

describe("buildMasterReportHtml", () => {
  it("builds the full report: TOC, numbered sections, every study, comparison", () => {
    const html = buildMasterReportHtml(input);
    expect(html).toContain("Helios CFD — Engineering Report");
    expect(html).toContain("1. Executive summary");
    expect(html).toContain("Design comparison");
    expect(html).toContain("Sweep — baseline sweep"); // custom name flows in
    expect(html).toContain("Optimization —");
    expect(html).toContain("Appendix — study registry");
    // Dyno validation line with RMSE/bias for the attached reference.
    expect(html).toMatch(/Dyno validation:.*RMSE.*kW.*bias/s);
    // Knock flag on the trial with KI 1.4, in the top-designs table.
    expect(html).toContain("⚠ 1.40");
    // Sensitivity table rows for both tunables.
    expect(html).toContain("runner_length");
    expect(html).toContain("plenum_volume_l");
    // Lap telemetry (roadmap #9) for the best design.
    expect(html).toContain("Lap telemetry");
    expect(html).toContain("power-ltd");
    // Lap-sim deep-dive: traces, limit-state strip + fractions, skidpad validation.
    expect(html).toContain("Lap simulation — traces &amp; limit states");
    expect(html).toContain("power-limited");
    expect(html).toContain("cornering ceiling");
    expect(html).toContain("Grip-model validation — skidpad");
  });

  it("scopes to one study: title changes, the other study disappears", () => {
    const html = buildMasterReportHtml({ ...input, only: ["sw1"] });
    expect(html).toContain("Study report — baseline sweep");
    expect(html).toContain("Sweep — baseline sweep");
    expect(html).not.toContain("Optimization —");
    expect(html).not.toContain("op1");
  });

  it("escapes HTML in user-controlled names", () => {
    const evil = makeSweepStudy({ id: "sw2", name: '<img src=x onerror="x">' });
    const html = buildMasterReportHtml({ ...input, studies: { sw2: evil }, only: ["sw2"] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img");
  });
});
