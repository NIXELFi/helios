// Pacejka Magic Formula tire-property (.tir) support for the lap sim.
//
// PROPRIETARY-DATA RULE: tire fit data is team-confidential. Nothing from a
// real .tir file may ever be committed to this repo — this module is a
// runtime LOADER only. The user imports a file in the app; we distill the
// handful of peak-friction coefficients the quasi-steady lap sim needs and
// keep them in app state. Tests use synthetic, made-up coefficients.
//
// What the lap sim needs from MF6.x is only the PEAK friction vs load (the
// QSS solver never works in slip space): at zero camber and the file's
// operating pressure,
//   mux(Fz) = (PDX1 + PDX2·dfz) · (1 + PPX3·dpi + PPX4·dpi²) · LMUX
//   muy(Fz) = |PDY1 + PDY2·dfz| · (1 + PPY3·dpi + PPY4·dpi²) · LMUY
// with dfz = (Fz − Fz0')/Fz0', Fz0' = FNOMIN·LFZ0, dpi = (p − NOMPRES)/NOMPRES.
// (Pacejka 2012 §4.3.2, MF6.1 — the same expressions OptimumT exports.)
// NOTE the load term is ADDITIVE (PDY1 + PDY2·dfz): with ISO-negative PDY1
// and positive PDY2, |μ| rises at light loads — proper load sensitivity.

/** Distilled peak-friction model from a .tir file — plain numbers only so it
 *  can live in persisted app state. `scale` is the track-surface correction
 *  (TTC flat-belt grip never fully transfers to asphalt; 0.6–0.75 typical)
 *  and is the ONE calibration knob. */
export interface TirGrip {
  label: string;
  /** Adapted nominal load Fz0' = FNOMIN·LFZ0 (N). */
  fz0: number;
  /** Normalized inflation-pressure offset dpi at the file's INFLPRES. */
  dpi: number;
  /** Loaded radius if present (m) — display only. */
  radiusM: number | null;
  // longitudinal peak-friction coefficients
  pdx1: number;
  pdx2: number;
  ppx3: number;
  ppx4: number;
  lmux: number;
  // lateral peak-friction coefficients
  pdy1: number;
  pdy2: number;
  ppy3: number;
  ppy4: number;
  lmuy: number;
  /** LATERAL surface scale applied on top of the MF value. */
  scale: number;
  /** Optional LONGITUDINAL surface scale; falls back to `scale`. The
   *  belt→asphalt transfer measurably differs per axis (the 2026 SDM26
   *  anchors want lat ≈ 0.625 vs long ≈ 0.70). */
  scaleLong?: number;
}

/** Parse the ADAMS/OptimumT property-file format: [SECTION] blocks of
 *  `KEY = value $ comment` lines, `$`/`!` comments, quoted strings. Returns
 *  a flat map (keys are globally unique in MF tir files) plus the values we
 *  can't represent as numbers. */
export function parseTirText(text: string): Map<string, number | string> {
  const out = new Map<string, number | string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("$") || line.startsWith("!") || line.startsWith("[") || line.startsWith("{")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    let val = line.slice(eq + 1);
    const dollar = val.indexOf("$");
    if (dollar >= 0) val = val.slice(0, dollar);
    val = val.trim();
    if (!key || !val) continue;
    const quoted = /^'(.*)'$/.exec(val);
    if (quoted) {
      out.set(key, quoted[1]!);
      continue;
    }
    const num = Number(val);
    out.set(key, Number.isFinite(num) ? num : val);
  }
  return out;
}

function num(kv: Map<string, number | string>, key: string, fallback: number): number {
  const v = kv.get(key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Distill a parsed .tir into the lap-sim peak-friction model. Throws when
 *  the file has no usable lateral peak-friction fit (PDY1 missing/zero).
 *  Default surface scales are the SDM26-anchored 2026 calibration: lateral
 *  0.62 reproduces the real 42.922 s autocross (under the per-axle roll
 *  model), longitudinal 0.70 the ~4.2 s accel (these are OUR track-transfer
 *  corrections, not tire data). */
export function distillTir(text: string, label: string, scale = 0.62, scaleLong = 0.70): TirGrip {
  const kv = parseTirText(text);
  const pdy1 = num(kv, "PDY1", 0);
  if (pdy1 === 0) {
    throw new Error("Not a usable .tir: missing lateral peak friction (PDY1)");
  }
  const fnomin = num(kv, "FNOMIN", 0);
  if (fnomin <= 0) {
    throw new Error("Not a usable .tir: missing nominal load (FNOMIN)");
  }
  const nompres = num(kv, "NOMPRES", 0);
  const inflpres = num(kv, "INFLPRES", nompres);
  const dpi = nompres > 0 ? (inflpres - nompres) / nompres : 0;
  return {
    label,
    fz0: fnomin * num(kv, "LFZ0", 1),
    dpi,
    radiusM: kv.has("UNLOADED_RADIUS") ? num(kv, "UNLOADED_RADIUS", 0) : null,
    pdx1: num(kv, "PDX1", Math.abs(pdy1)),
    pdx2: num(kv, "PDX2", 0),
    ppx3: num(kv, "PPX3", 0),
    ppx4: num(kv, "PPX4", 0),
    lmux: num(kv, "LMUX", 1),
    pdy1,
    pdy2: num(kv, "PDY2", 0),
    ppy3: num(kv, "PPY3", 0),
    ppy4: num(kv, "PPY4", 0),
    lmuy: num(kv, "LMUY", 1),
    scale,
    scaleLong,
  };
}

/** Floor: the linear-in-dfz peak-friction law goes unphysical when
 *  extrapolated far above the fit's load range; never let μ fall below 20%
 *  of its nominal-load value. */
function muFloor(muNom: number, mu: number): number {
  return Math.max(Math.abs(muNom) * 0.2, mu);
}

/** Peak LATERAL friction coefficient at vertical load `fz` (N), surface
 *  scale included. */
export function tirMuLat(t: TirGrip, fz: number): number {
  const dfz = (fz - t.fz0) / t.fz0;
  const pressure = 1 + t.ppy3 * t.dpi + t.ppy4 * t.dpi * t.dpi;
  const mu = Math.abs(t.pdy1 + t.pdy2 * dfz) * pressure * t.lmuy;
  return muFloor(t.pdy1 * pressure, mu) * t.scale;
}

/** Peak LONGITUDINAL friction coefficient at vertical load `fz` (N), surface
 *  scale included. */
export function tirMuLong(t: TirGrip, fz: number): number {
  const dfz = (fz - t.fz0) / t.fz0;
  const pressure = 1 + t.ppx3 * t.dpi + t.ppx4 * t.dpi * t.dpi;
  const mu = Math.abs(t.pdx1 + t.pdx2 * dfz) * pressure * t.lmux;
  return muFloor(t.pdx1 * pressure, mu) * (t.scaleLong ?? t.scale);
}
