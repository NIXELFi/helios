// Measured-dyno engine source: wheel→crank conversion + banded accuracy.

import { describe, it, expect } from "vitest";
import { torqueCurveFromDyno } from "../torqueCurve";
import { compareDynoBanded } from "../../analytics/dynoCompare";

describe("torqueCurveFromDyno", () => {
  it("divides measured wheel torque by drivetrain efficiency (crank-side curve)", () => {
    const curve = torqueCurveFromDyno(
      [{ rpm: 8000, powerKw: null, torqueNm: 42.5 }],
      0.85,
    );
    expect(curve).toHaveLength(1);
    expect(curve[0]!.torqueNm).toBeCloseTo(50, 5);
  });

  it("derives torque from power when the CSV has no torque column", () => {
    // P = tau * omega → tau = P*1000 / (2*pi*rpm/60)
    const rpm = 9549.297; // makes omega = 1000 rad/s
    const curve = torqueCurveFromDyno([{ rpm, powerKw: 40, torqueNm: null }], 1.0);
    expect(curve[0]!.torqueNm).toBeCloseTo(40, 2);
  });

  it("sorts by rpm and drops points with neither power nor torque", () => {
    const curve = torqueCurveFromDyno(
      [
        { rpm: 12000, powerKw: null, torqueNm: 30 },
        { rpm: 6000, powerKw: null, torqueNm: null },
        { rpm: 8000, powerKw: null, torqueNm: 45 },
      ],
      1.0,
    );
    expect(curve.map((p) => p.rpm)).toEqual([8000, 12000]);
  });
});

describe("compareDynoBanded", () => {
  const sim = [
    { rpm: 4000, powerKw: 20 },
    { rpm: 14000, powerKw: 45 },
  ];
  it("scores each finding-0028 band over its own dyno slice", () => {
    const bands = compareDynoBanded(sim, [
      { rpm: 5000, powerKw: 22, torqueNm: null }, // below every band
      { rpm: 8000, powerKw: 30, torqueNm: null }, // wot + peak
      { rpm: 12000, powerKw: 40, torqueNm: null }, // wot + high
    ]);
    const byKey = Object.fromEntries(bands.map((b) => [b.key, b.cmp]));
    expect(byKey["wot"]?.n).toBe(2);
    expect(byKey["peak"]?.n).toBe(1);
    expect(byKey["high"]?.n).toBe(1);
  });

  it("returns null cmp for a band with no dyno points", () => {
    const bands = compareDynoBanded(sim, [{ rpm: 5000, powerKw: 22, torqueNm: null }]);
    expect(bands.every((b) => b.cmp === null)).toBe(true);
  });
});
