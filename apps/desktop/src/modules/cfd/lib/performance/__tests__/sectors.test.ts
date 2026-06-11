import { describe, it, expect } from "vitest";

import type { VehicleConfig } from "../types";
import type { TorqueCurve } from "../torqueCurve";
import { simLap } from "../lapSim";
import { lapSectors, sectorDeltas } from "../sectors";
import { synthesizeAutocross } from "../track";

const flatCurve = (t: number): TorqueCurve => [
  { rpm: 0, torqueNm: t },
  { rpm: 20000, torqueNm: t },
];

const VEHICLE: VehicleConfig = {
  name: "test",
  massKg: 250,
  weightDistFront: 0.5,
  cgHeightM: 0.3,
  wheelbaseM: 1.5,
  trackWidthM: 1.2,
  tireRadiusM: 0.2,
  muLong: 1.5,
  muLat: 1.6,
  tireLoadSensitivity: 0,
  cdaM2: 1.0,
  claM2: 0,
  airDensityKgM3: 1.162,
  crr: 0.02,
  drivetrainEff: 0.9,
  gearRatios: [2.75, 2.0, 1.667, 1.444, 1.304, 1.208],
  primaryReduction: 2.111,
  finalDrive: 3.0,
  shiftRpm: 9000,
  revLimitRpm: 14500,
  shiftTimeS: 0.1,
};

const track = synthesizeAutocross();

describe("lapSectors", () => {
  const ch = simLap(flatCurve(60), VEHICLE, track, { channels: true }).channels!;
  const sectors = lapSectors(ch);

  it("tiles the whole lap contiguously with no gaps or overlaps", () => {
    expect(sectors.length).toBeGreaterThan(1); // autocross has braking zones
    expect(sectors[0]!.startM).toBe(0);
    for (let i = 1; i < sectors.length; i++) {
      expect(sectors[i]!.startM).toBeCloseTo(sectors[i - 1]!.endM, 9);
      expect(sectors[i]!.idx).toBe(i + 1);
    }
    // Sector times sum to the channel clock's final value.
    const sum = sectors.reduce((acc, s) => acc + s.timeS, 0);
    expect(sum).toBeCloseTo(ch.tS[ch.tS.length - 1]!, 6);
  });

  it("every boundary after the first sits at a brake application", () => {
    for (const s of sectors.slice(1)) {
      const i = ch.distM.findIndex((d) => d >= s.startM);
      expect(ch.limit[i]).toBe("brake");
      expect(ch.limit[i - 1]).not.toBe("brake");
    }
  });

  it("respects the minimum sector length (no slivers)", () => {
    for (const s of sectors) expect(s.endM - s.startM).toBeGreaterThanOrEqual(40);
  });

  it("limit fractions per sector sum to ~1 and the dominant state has the largest share", () => {
    for (const s of sectors) {
      const fracs = Object.values(s.limitFrac) as number[];
      expect(fracs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      const domFrac = s.limitFrac[s.dominant]!;
      for (const f of fracs) expect(domFrac).toBeGreaterThanOrEqual(f - 1e-12);
    }
  });

  it("a lap with no braking is a single whole-lap sector", () => {
    const straightCh = simLap(
      flatCurve(60),
      VEHICLE,
      { name: "drag", segments: [{ length: 500, radius: Infinity }], closed: false },
      { channels: true },
    ).channels!;
    const s = lapSectors(straightCh);
    expect(s.length).toBe(1);
    expect(s[0]!.startM).toBe(0);
  });
});

describe("sectorDeltas", () => {
  it("a lap vs itself is ~zero everywhere; a slower car loses time in most sectors", () => {
    // A POWER-limited car (flat 25 Nm), so an engine cut actually costs time —
    // the 60 Nm monster is traction-limited and barely notices one.
    const a = simLap(flatCurve(25), VEHICLE, track, { channels: true }).channels!;
    const sectors = lapSectors(a);
    for (const d of sectorDeltas(sectors, a)) expect(Math.abs(d)).toBeLessThan(1e-9);

    // Lower driveline efficiency scales every gear's force uniformly: the
    // shift crossovers (force RATIOS) stay identical, so the slower car runs
    // the same schedule and is strictly slower over every piece of road.
    const slow = simLap(flatCurve(25), { ...VEHICLE, drivetrainEff: 0.6 }, track, { channels: true }).channels!;
    const deltas = sectorDeltas(sectors, slow);
    const total = deltas.reduce((x, y) => x + y, 0);
    expect(total).toBeGreaterThan(0.1);
    // No sector should show the slower car meaningfully AHEAD.
    for (const d of deltas) expect(d).toBeGreaterThan(-0.02);
  });
});
