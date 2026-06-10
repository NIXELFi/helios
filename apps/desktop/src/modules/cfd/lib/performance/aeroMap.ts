// Helios aero-map (.csv) support: ride-height-dependent Cl / Cd / front-
// downforce-fraction tables from the team's CFD aero map.
//
// PROPRIETARY-DATA RULE: like the .tir tire fit, aero map data is
// team-confidential and never ships in the repo — this is a runtime loader;
// tests use synthetic invented coefficients.
//
// Canonical format (header + one row schema; '#' comments ignored):
//   record,name,front_rh_in,rear_rh_in,value
//   meta,vehicle,,,SDM26
//   meta,frontal_area_m2,,,1.078
//   data,cl,0,0,2.918278
//   data,cd,0,0,1.200317
//   data,front_frac,0,0,0.552631
// Tables are sampled on a (front, rear) ride-height grid (inches offset from
// the nominal setup); bad-mesh cells are simply absent. Coefficients are
// dimensionless: ClA/CdA [m²] = coefficient × frontal_area_m2.

export interface AeroCell {
  frontRhIn: number;
  rearRhIn: number;
  value: number;
}

export interface AeroMap {
  label: string;
  vehicle: string | null;
  frontalAreaM2: number;
  tables: Record<string, AeroCell[]>;
}

export function parseAeroMap(text: string, label: string): AeroMap {
  const tables: Record<string, AeroCell[]> = {};
  let vehicle: string | null = null;
  let frontalAreaM2 = NaN;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(",").map((c) => c.trim());
    if (cols[0] === "record") continue; // header
    if (cols[0] === "meta") {
      if (cols[1] === "vehicle") vehicle = cols[4] || null;
      if (cols[1] === "frontal_area_m2") frontalAreaM2 = Number(cols[4]);
      continue;
    }
    if (cols[0] !== "data" || cols.length < 5) continue;
    const name = cols[1]!;
    const f = Number(cols[2]);
    const r = Number(cols[3]);
    const v = Number(cols[4]);
    if (!Number.isFinite(f) || !Number.isFinite(r) || !Number.isFinite(v)) continue;
    (tables[name] ??= []).push({ frontRhIn: f, rearRhIn: r, value: v });
  }
  if (!Number.isFinite(frontalAreaM2) || frontalAreaM2 <= 0) {
    throw new Error("Aero map: missing/invalid meta frontal_area_m2");
  }
  if (!tables["cl"]?.length || !tables["cd"]?.length) {
    throw new Error("Aero map: needs at least 'cl' and 'cd' data tables");
  }
  return { label, vehicle, frontalAreaM2, tables };
}

/** Inverse-distance-weighted sample of a table at (front, rear) ride height —
 *  robust to missing (bad-mesh) cells, exact on grid points. */
export function sampleAero(cells: AeroCell[], frontRhIn: number, rearRhIn: number): number {
  let wSum = 0;
  let vSum = 0;
  for (const c of cells) {
    const d2 = (c.frontRhIn - frontRhIn) ** 2 + (c.rearRhIn - rearRhIn) ** 2;
    if (d2 < 1e-12) return c.value;
    const w = 1 / d2;
    wSum += w;
    vSum += w * c.value;
  }
  return wSum > 0 ? vSum / wSum : NaN;
}

export interface AeroNominal {
  claM2: number;
  cdaM2: number;
  /** Front share of total downforce (0..1); NaN when the map lacks it. */
  aeroFrontFrac: number;
}

/** Distill the vehicle-model aero numbers at a ride-height point (default:
 *  nominal setup, 0/0). */
export function distillAero(map: AeroMap, frontRhIn = 0, rearRhIn = 0): AeroNominal {
  return {
    claM2: sampleAero(map.tables["cl"]!, frontRhIn, rearRhIn) * map.frontalAreaM2,
    cdaM2: sampleAero(map.tables["cd"]!, frontRhIn, rearRhIn) * map.frontalAreaM2,
    aeroFrontFrac: map.tables["front_frac"]?.length
      ? sampleAero(map.tables["front_frac"]!, frontRhIn, rearRhIn)
      : NaN,
  };
}
