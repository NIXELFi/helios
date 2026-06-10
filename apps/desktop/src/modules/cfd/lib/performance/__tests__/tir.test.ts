// .tir loader + Pacejka peak-friction math. The fixture below is SYNTHETIC —
// invented coefficients, not any team's tire data (which is proprietary and
// must never enter the repo).

import { describe, it, expect } from "vitest";
import { parseTirText, distillTir, tirMuLat, tirMuLong } from "../tir";
import { makeGripModel } from "../lapSim";
import { tractionLimit } from "../tractive";
import { SDM26_VEHICLE } from "../vehicle";

const SYNTH = `[MDI_HEADER]
FILE_TYPE                = 'tir'
$---------------------------------------------------------------UNITS
[UNITS]
LENGTH                    = 'meter'                   $
[MODEL]
FITTYP                    = 61                        $ Magic Formula Version
! comment line that must be ignored
[DIMENSION]
UNLOADED_RADIUS           = 0.25                      $ Free tyre radius
[OPERATING_CONDITIONS]
INFLPRES                  = 90000                     $ operating
NOMPRES                   = 100000                    $ nominal
[VERTICAL]
FNOMIN                    = 2000                      $ Nominal wheel load
[SCALING_COEFFICIENTS]
LFZ0                      = 1
LMUX                      = 1
LMUY                      = 1
[LONGITUDINAL_COEFFICIENTS]
PDX1                      = 2.0                       $ mux at Fznom
PDX2                      = -0.1                      $ load sensitivity
PPX3                      = 0                         $
PPX4                      = 0                         $
[LATERAL_COEFFICIENTS]
PDY1                      = -2.5                      $ muy at Fznom (ISO sign)
PDY2                      = 0.2                       $ load sensitivity
PPY3                      = 0.5                       $ pressure linear
PPY4                      = 0                         $
`;

describe("parseTirText", () => {
  it("parses sections, numbers, quoted strings, and strips comments", () => {
    const kv = parseTirText(SYNTH);
    expect(kv.get("FNOMIN")).toBe(2000);
    expect(kv.get("PDY1")).toBe(-2.5);
    expect(kv.get("FILE_TYPE")).toBe("tir");
    expect(kv.has("[UNITS]")).toBe(false);
  });
});

describe("distillTir + peak friction", () => {
  const t = distillTir(SYNTH, "synth.tir", 1.0, 1.0);

  it("computes dpi from operating vs nominal pressure", () => {
    expect(t.dpi).toBeCloseTo(-0.1, 10);
    expect(t.radiusM).toBe(0.25);
  });

  it("lateral mu: |PDY1 + PDY2·dfz|·(1+PPY3·dpi)·scale (ADDITIVE load term)", () => {
    // at Fz = Fz0: |−2.5 + 0|·(1 + 0.5·(−0.1)) = 2.5·0.95 = 2.375
    expect(tirMuLat(t, 2000)).toBeCloseTo(2.375, 6);
    // at half load, dfz = −0.5: |−2.5 + 0.2·(−0.5)| = 2.6 → ·0.95 = 2.47
    expect(tirMuLat(t, 1000)).toBeCloseTo(2.6 * 0.95, 6);
    // grip RISES at light loads (load sensitivity) — the FSAE regime
    expect(tirMuLat(t, 600)).toBeGreaterThan(tirMuLat(t, 2000));
  });

  it("longitudinal mu uses the X coefficients (no pressure terms here)", () => {
    expect(tirMuLong(t, 2000)).toBeCloseTo(2.0, 6);
    // dfz = −0.5: |2.0 + (−0.1)(−0.5)| = 2.05
    expect(tirMuLong(t, 1000)).toBeCloseTo(2.05, 6);
  });

  it("surface scales multiply straight through, per axis", () => {
    const scaled = { ...t, scale: 0.7, scaleLong: 0.9 };
    expect(tirMuLat(scaled, 2000)).toBeCloseTo(2.375 * 0.7, 6);
    expect(tirMuLong(scaled, 2000)).toBeCloseTo(2.0 * 0.9, 6);
  });

  it("rejects files without a lateral fit", () => {
    expect(() => distillTir("[VERTICAL]\nFNOMIN = 2000\n", "bad.tir")).toThrow(/PDY1/);
  });
});

describe("grip-model integration", () => {
  const tire = { ...distillTir(SYNTH, "synth.tir", 1.0, 1.0), scale: 0.7, scaleLong: 0.7 };

  it("a vehicle with a tire model corners on tirMuLat, not muLat", () => {
    const base = makeGripModel(SDM26_VEHICLE);
    const withTir = makeGripModel({ ...SDM26_VEHICLE, tire });
    // Synthetic tire at FSAE loads: mu ≈ 0.7·2.5·(1+0.2·dfz)·0.95 ≈ 1.9 ≫ 1.55
    expect(withTir.latCap(10, 50)).toBeGreaterThan(base.latCap(10, 50));
    // corner-speed ceiling rises accordingly
    expect(withTir.vCorner(30)).toBeGreaterThan(base.vCorner(30));
  });

  it("traction limit uses the measured longitudinal fit when present", () => {
    const withTir = tractionLimit({ ...SDM26_VEHICLE, tire }, 0);
    const without = tractionLimit(SDM26_VEHICLE, 0);
    expect(withTir).not.toBeCloseTo(without, 1);
    expect(withTir).toBeGreaterThan(0);
  });
});
