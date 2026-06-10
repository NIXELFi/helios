// Aero-map (.csv) loader. SYNTHETIC coefficients — team aero data is
// proprietary and never enters the repo.

import { describe, it, expect } from "vitest";
import { parseAeroMap, distillAero, sampleAero } from "../aeroMap";

const SYNTH = `# Helios aero map v1 — synthetic test fixture
record,name,front_rh_in,rear_rh_in,value
meta,vehicle,,,TESTCAR
meta,frontal_area_m2,,,1.0
meta,air_density_kgm3,,,1.225
data,cl,0,0,3.0
data,cl,-1,0,3.2
data,cl,1,0,2.6
data,cd,0,0,1.2
data,cd,-1,0,1.1
data,front_frac,0,0,0.55
`;

describe("parseAeroMap / distillAero", () => {
  const map = parseAeroMap(SYNTH, "synth.csv");

  it("parses meta + tables, skipping comments and the header", () => {
    expect(map.vehicle).toBe("TESTCAR");
    expect(map.frontalAreaM2).toBe(1.0);
    expect(map.tables["cl"]).toHaveLength(3);
    expect(map.tables["cd"]).toHaveLength(2);
  });

  it("distills nominal ClA/CdA/front fraction at (0,0)", () => {
    const n = distillAero(map);
    expect(n.claM2).toBeCloseTo(3.0, 6);
    expect(n.cdaM2).toBeCloseTo(1.2, 6);
    expect(n.aeroFrontFrac).toBeCloseTo(0.55, 6);
  });

  it("samples exactly on grid points and sanely between them", () => {
    expect(sampleAero(map.tables["cl"]!, -1, 0)).toBeCloseTo(3.2, 6);
    const mid = sampleAero(map.tables["cl"]!, -0.5, 0);
    expect(mid).toBeGreaterThan(3.0);
    expect(mid).toBeLessThan(3.2);
  });

  it("rejects maps without cl/cd or frontal area", () => {
    expect(() => parseAeroMap("record,name,front_rh_in,rear_rh_in,value\nmeta,frontal_area_m2,,,1\n", "x")).toThrow(/cl/);
    expect(() => parseAeroMap("data,cl,0,0,3\ndata,cd,0,0,1\n", "x")).toThrow(/frontal_area/);
  });
});
