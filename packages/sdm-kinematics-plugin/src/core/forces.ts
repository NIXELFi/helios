// Dynamic force calculator — the plugin port of the team's MATLAB pair
// (Phasor_Force_Calc_V2.m + SDM27_Load_Transfer.m), upgraded to use the live
// kinematics:
//   · Fz per tire from geometric + elastic + unsprung load transfer with a
//     roll-stiffness-distribution split (the SDM27 model), but the roll
//     center heights and pitch center come from the CURRENT solved geometry
//     instead of hardcoded constants.
//   · Fx/Fy distributed over the loaded tires (brake bias front/rear under
//     braking, RWD under acceleration, Fz-proportional within an axle);
//     wheel lift clamps a corner to zero and redistributes.
//   · Each corner's six links (LCA fore/aft, UCA fore/aft, toe, pushrod)
//     solved as axial two-force members from a 6×6 rigid-upright equilibrium
//     at the LOADED pose (chassis roll/pitch from the spring wheel rates),
//     so link directions reflect the deflected geometry. Braking torque is
//     reacted through the upright (outboard brakes); drive torque is not
//     (inboard diff → halfshafts).
// Inputs: a G-G envelope phasor sweep (θ from vertical, like the MATLAB) or
// an imported CSV acceleration trace.

import { type V3, add, sub, scale, dot, cross, unit, rad, solveLinear } from "./vec";
import {
  mirrorAxle, trackWidth, wheelbase,
  type AxleGeometry, type CarSetup, type CornerId, CORNERS, type Pose,
} from "./model";
import { solveCar, type FullState } from "./sweep";
import type { CornerState } from "./solver";

export interface MassProps {
  /** Sprung weight incl. driver, lb. */
  sprungWeight: number;
  frontWeightDist: number; // 0–1
  unsprungWeightFront: number; // per axle, lb
  unsprungWeightRear: number;
  unsprungCgHeight: number; // in
  /** Roll stiffness distribution, front fraction of the ELASTIC transfer. */
  rsd: number;
}

export function defaultMassProps(): MassProps {
  // SDM27_Load_Transfer.m values.
  return {
    sprungWeight: 509,
    frontWeightDist: 0.48,
    unsprungWeightFront: 33,
    unsprungWeightRear: 38,
    unsprungCgHeight: 8,
    rsd: 0.5,
  };
}

export const LINK_NAMES = ["LCAF", "LCAA", "UCAF", "UCAA", "TOE", "PR"] as const;
export type LinkName = (typeof LINK_NAMES)[number];

export interface ForceSample {
  ax: number; // G, + forward accel
  ay: number; // G, + leftward accel (left turn)
  t: number; // s for traces, θ deg for envelopes
}

export interface CornerForces {
  /** Tire forces at the contact patch, lbf (car axes). */
  tire: V3;
  /** Axial force per link, lbf, tension positive. */
  links: Record<LinkName, number>;
  lifted: boolean;
}

export interface ForceResult {
  samples: ForceSample[];
  xLabel: string;
  poses: Pose[];
  corners: Record<CornerId, CornerForces>[];
  /** Peak tension/compression per corner+link over the run. */
  peaks: Record<CornerId, Record<LinkName, { min: number; max: number }>>;
  tirePeaks: Record<CornerId, { fzMin: number; fzMax: number }>;
  liftedSamples: number;
  /** Derived geometry used by the load-transfer model. */
  info: { frch: number; rrch: number; pch: number; pcx: number; kPhiF: number; kPhiR: number };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Phasor sweep around a quadrant-blended G-G ellipse (θ from vertical, like
 *  the MATLAB plotter: θ=0 is pure accel, 90 pure left turn, 180 braking). */
export function ggEnvelope(latG: number, accelG: number, brakeG: number, n = 72): ForceSample[] {
  const out: ForceSample[] = [];
  for (let i = 0; i < n; i++) {
    const th = (360 * i) / n;
    const c = Math.cos(rad(th));
    const s = Math.sin(rad(th));
    out.push({ ax: c * (c >= 0 ? accelG : brakeG), ay: s * latG, t: th });
  }
  return out;
}

/** Parse a numeric CSV; returns column headers + column-major data. */
export function parseCsv(text: string): { headers: string[]; cols: number[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV has no data rows");
  const delim = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const first = lines[0].split(delim).map((s) => s.trim());
  const firstNumeric = first.every((s) => s !== "" && Number.isFinite(Number(s)));
  const headers = firstNumeric ? first.map((_, i) => `col ${i + 1}`) : first;
  const start = firstNumeric ? 0 : 1;
  const cols: number[][] = headers.map(() => []);
  for (let r = start; r < lines.length; r++) {
    const parts = lines[r].split(delim);
    for (let cIdx = 0; cIdx < headers.length; cIdx++) {
      const v = Number(parts[cIdx]);
      cols[cIdx].push(Number.isFinite(v) ? v : NaN);
    }
  }
  return { headers, cols };
}

/** Build samples from parsed CSV columns; strides down to ≤ maxSamples. */
export function traceFromCsv(
  cols: number[][], axCol: number, ayCol: number, tCol: number | null, maxSamples = 1500,
): ForceSample[] {
  const n = cols[axCol].length;
  const stride = Math.max(1, Math.ceil(n / maxSamples));
  const out: ForceSample[] = [];
  for (let i = 0; i < n; i += stride) {
    const ax = cols[axCol][i];
    const ay = cols[ayCol][i];
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
    out.push({ ax, ay, t: tCol !== null && Number.isFinite(cols[tCol][i]) ? cols[tCol][i] : i });
  }
  if (out.length < 2) throw new Error("no usable numeric rows in the selected columns");
  return out;
}

// ---------------------------------------------------------------------------
// Load transfer (SDM27 model, live geometry)
// ---------------------------------------------------------------------------

interface TransferGeom { frch: number; rrch: number; pch: number; pcx: number; kPhiF: number; kPhiR: number }

/** Fz per corner (lbf). Follows SDM27_Load_Transfer.m: elastic lateral
 *  transfer split by RSD, geometric via the roll-center heights, unsprung at
 *  its own CG height; longitudinal split geometric/elastic via the pitch
 *  center height. */
function cornerFz(car: CarSetup, mp: MassProps, g: TransferGeom, ax: number, ay: number): Record<CornerId, number> {
  const tf = trackWidth(car.front);
  const tr = trackWidth(car.rear);
  const wb = wheelbase(car);
  const W = mp.sprungWeight;
  const fd = mp.frontWeightDist;
  const cg = car.params.cgHeight;

  const frontCorner = (W * fd) / 2 + mp.unsprungWeightFront / 2;
  const rearCorner = (W * (1 - fd)) / 2 + mp.unsprungWeightRear / 2;

  // Lateral (ay + = left turn → load onto the RIGHT side).
  const elastic = ((cg - g.frch) * (fd * W) * ay) / tf + ((cg - g.rrch) * ((1 - fd) * W) * ay) / tr;
  const geoF = (g.frch * (fd * W) * ay) / tf;
  const geoR = (g.rrch * ((1 - fd) * W) * ay) / tr;
  const usF = (mp.unsprungCgHeight * mp.unsprungWeightFront * ay) / tf;
  const usR = (mp.unsprungCgHeight * mp.unsprungWeightRear * ay) / tr;
  const latF = mp.rsd * elastic + geoF + usF;
  const latR = (1 - mp.rsd) * elastic + geoR + usR;

  // Longitudinal (ax + = accel → load onto the REAR). NOTE: this is the
  // PER-WHEEL delta = axle transfer / 2. SDM27_Load_Transfer.m applies the
  // full W·Ax·h/wb to each corner, which double-counts the pitch moment
  // (its lateral terms are per-wheel and correct); fixed here.
  const usLong = ((mp.unsprungWeightFront + mp.unsprungWeightRear) * ax * mp.unsprungCgHeight) / wb;
  const geoLong = (W * ax * g.pch) / wb;
  const elLong = (W * ax * (cg - g.pch)) / wb;
  const long = (usLong + geoLong + elLong) / 2;

  return {
    FL: frontCorner - latF - long,
    FR: frontCorner + latF - long,
    RL: rearCorner - latR + long,
    RR: rearCorner + latR + long,
  };
}

// ---------------------------------------------------------------------------
// Link force solve
// ---------------------------------------------------------------------------

/** 6×6 axial equilibrium of the rigid upright: three force + three moment
 *  equations about the wheel center, unknowns = tension in each link. The
 *  pushrod is taken at its actual pickup even when arm-mounted (the standard
 *  simplification — the vertical load path passes through the adjacent ball
 *  joint bracket). */
function solveLinkForces(
  geo: AxleGeometry, st: CornerState, cp: V3, tireF: V3, driven: boolean,
): Record<LinkName, number> | null {
  const wc = st.wheelCenter;
  // Sixth member: the pushrod for rod-actuated setups, or the coilover
  // itself when the shock acts directly on the outboard pickup.
  const sixth = geo.config.actuation === "direct-coilover"
    ? { out: st.pushLower, dir: unit(sub(geo.shockChassis, st.pushLower)) }
    : { out: st.pushLower, dir: unit(sub(st.pushUpper, st.pushLower)) };
  const members: { out: V3; dir: V3 }[] = [
    { out: st.p1, dir: unit(sub(geo.lcaFront, st.p1)) },
    { out: st.p1, dir: unit(sub(geo.lcaRear, st.p1)) },
    { out: st.p2, dir: unit(sub(geo.ucaFront, st.p2)) },
    { out: st.p2, dir: unit(sub(geo.ucaRear, st.p2)) },
    { out: st.p3, dir: unit(sub(st.tieInner, st.p3)) },
    sixth,
  ];

  const rp = sub(cp, wc);
  let M = cross(rp, tireF);
  if (driven && tireF[0] > 0) {
    // Drive torque reacts through the halfshaft, not the linkage — remove
    // the wheel-axis component of the applied moment.
    const a = unit(sub(st.wheelAxisOuter, wc));
    M = sub(M, scale(a, dot(M, a)));
  }

  // Rows: ΣF = −F_tire, ΣM(about wc) = −M.
  const A: number[][] = [];
  for (let r = 0; r < 6; r++) A.push(new Array(6).fill(0));
  const b = [-tireF[0], -tireF[1], -tireF[2], -M[0], -M[1], -M[2]];
  members.forEach((m, j) => {
    const r = sub(m.out, wc);
    const mom = cross(r, m.dir);
    A[0][j] = m.dir[0];
    A[1][j] = m.dir[1];
    A[2][j] = m.dir[2];
    A[3][j] = mom[0];
    A[4][j] = mom[1];
    A[5][j] = mom[2];
  });
  const x = solveLinear(A, b);
  if (!x) return null;
  return { LCAF: x[0], LCAA: x[1], UCAF: x[2], UCAA: x[3], TOE: x[4], PR: x[5] };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function runForces(
  car: CarSetup,
  mp: MassProps,
  samples: ForceSample[],
  xLabel: string,
  /** Static full state (with probes) — supplies RC heights, side-view
   *  slopes, and wheel rates for the pose model. */
  staticState: FullState,
): ForceResult {
  for (const axle of ["front", "rear"] as const) {
    const c = car[axle].config;
    if (c.type !== "double-wishbone" || c.actuation === "rocker-arm") {
      throw new Error(
        "link-force calc supports double-wishbone axles with rod-actuated or direct coilovers in this version " +
        `(${axle} is ${c.type}/${c.actuation})`,
      );
    }
  }
  // Live geometry for the transfer model.
  const frch = staticState.frontAxle.rollCenter[1];
  const rrch = staticState.rearAxle.rollCenter[1];
  // Pitch center: intersection of the front & rear side-view n-lines.
  const xf = car.front.wheelCenter[0];
  const xr = car.rear.wheelCenter[0];
  const sf = staticState.frontAxle.svSlope;
  const sr = staticState.rearAxle.svSlope;
  let pcx = (xf + xr) / 2, pch = 1.5;
  if (Number.isFinite(sf) && Number.isFinite(sr) && Math.abs(sf - sr) > 1e-6) {
    pcx = (sf * xf - sr * xr) / (sf - sr);
    pch = sf * (pcx - xf);
    if (!Number.isFinite(pch) || Math.abs(pch) > 20) { pcx = (xf + xr) / 2; pch = 1.5; }
  }
  // Spring-only roll/pitch stiffness from the live wheel rates (lb·in/rad).
  const wrF = (staticState.cornerCh.FL.wheelRate + staticState.cornerCh.FR.wheelRate) / 2;
  const wrR = (staticState.cornerCh.RL.wheelRate + staticState.cornerCh.RR.wheelRate) / 2;
  const tf = trackWidth(car.front), tr = trackWidth(car.rear);
  const kPhiF = (wrF * tf * tf) / 2;
  const kPhiR = (wrR * tr * tr) / 2;
  const geom: TransferGeom = { frch, rrch, pch, pcx, kPhiF, kPhiR };

  const W = mp.sprungWeight;
  const cg = car.params.cgHeight;
  const Wtot = W + mp.unsprungWeightFront + mp.unsprungWeightRear;
  const bias = car.params.brakeBiasFront;
  const xMid = (xf + xr) / 2;
  const kPitch =
    2 * (staticState.cornerCh.FL.wheelRate * (xf - xMid) ** 2 +
         staticState.cornerCh.RL.wheelRate * (xr - xMid) ** 2);

  const geoFL = car.front, geoFR = mirrorAxle(car.front);
  const geoRL = car.rear, geoRR = mirrorAxle(car.rear);
  const geoOf = (id: CornerId) => (id === "FL" ? geoFL : id === "FR" ? geoFR : id === "RL" ? geoRL : geoRR);

  const corners: Record<CornerId, CornerForces>[] = [];
  const poses: Pose[] = [];
  const peaks = {} as ForceResult["peaks"];
  const tirePeaks = {} as ForceResult["tirePeaks"];
  for (const id of CORNERS) {
    peaks[id] = {} as Record<LinkName, { min: number; max: number }>;
    for (const l of LINK_NAMES) peaks[id][l] = { min: Infinity, max: -Infinity };
    tirePeaks[id] = { fzMin: Infinity, fzMax: -Infinity };
  }
  let liftedSamples = 0;
  let warm: Record<CornerId, CornerState> | undefined;

  for (const s of samples) {
    // Chassis attitude from the elastic moments and spring stiffnesses.
    const rollDeg = ((W * s.ay * (cg - (frch + rrch) / 2)) / (kPhiF + kPhiR)) * (180 / Math.PI);
    const pitchDeg = ((W * s.ax * (cg - pch)) / Math.max(kPitch, 1)) * (180 / Math.PI);
    const pose: Pose = {
      heave: 0,
      rollDeg: Math.max(-4, Math.min(4, rollDeg)),
      pitchDeg: Math.max(-3, Math.min(3, -pitchDeg)),
      rack: 0,
    };
    poses.push(pose);
    const st = solveCar(car, pose, warm, { cornerProbes: false, axleProbes: false });
    if (CORNERS.every((id) => st.corners[id].ok)) warm = st.corners;

    // Fz + lift handling. When a corner goes negative, re-solve the exact
    // 3-wheel static problem (ΣFz, ΣMx, ΣMy preserved) instead of a plain
    // clamp — total weight and both moments stay conserved.
    const fz = cornerFz(car, mp, geom, s.ax, s.ay);
    const loaded: Record<CornerId, number> = { ...fz };
    const negatives = CORNERS.filter((id) => loaded[id] < 0);
    if (negatives.length === 1) {
      const liftedId = negatives[0];
      const others = CORNERS.filter((id) => id !== liftedId);
      const px = (id: CornerId) => (id[0] === "F" ? car.front : car.rear).wheelCenter[0];
      const py = (id: CornerId) => {
        const y = (id[0] === "F" ? car.front : car.rear).wheelCenter[1];
        return id[1] === "L" ? y : -y;
      };
      const Wt = CORNERS.reduce((a, id) => a + fz[id], 0);
      const Mx = CORNERS.reduce((a, id) => a + fz[id] * py(id), 0);
      const My = CORNERS.reduce((a, id) => a + fz[id] * px(id), 0);
      const A = others.map(() => [0, 0, 0]);
      others.forEach((id, j) => { A[0][j] = 1; A[1][j] = py(id); A[2][j] = px(id); });
      const sol = solveLinear([A[0].slice(), A[1].slice(), A[2].slice()], [Wt, Mx, My]);
      if (sol && sol.every((v) => v >= -1e-6)) {
        loaded[liftedId] = 0;
        others.forEach((id, j) => (loaded[id] = Math.max(0, sol[j])));
      } else {
        loaded[liftedId] = 0; // two-wheel territory — best effort
      }
    } else if (negatives.length > 1) {
      for (const id of negatives) loaded[id] = 0;
    }
    if (negatives.length) liftedSamples++;

    // Fy: Fz-proportional over all loaded tires.
    const sumFz = CORNERS.reduce((a, id) => a + loaded[id], 0) || 1;
    const fyTot = Wtot * s.ay;
    // Fx: braking split by bias front/rear then Fz-proportional within the
    // axle; acceleration is rear-only (RWD).
    const fxTot = Wtot * s.ax;
    const axleFz = (ids: CornerId[]) => ids.reduce((a, id) => a + loaded[id], 0) || 1;
    const fxAxle: Record<"F" | "R", number> = s.ax < 0
      ? { F: fxTot * bias, R: fxTot * (1 - bias) }
      : { F: 0, R: fxTot };

    const rec = {} as Record<CornerId, CornerForces>;
    for (const id of CORNERS) {
      const isF = id[0] === "F";
      const axleIds: CornerId[] = isF ? ["FL", "FR"] : ["RL", "RR"];
      const fx = fxAxle[isF ? "F" : "R"] * (loaded[id] / axleFz(axleIds));
      const fy = fyTot * (loaded[id] / sumFz);
      const tire: V3 = [fx, fy, loaded[id]];
      const cst = st.corners[id];
      const links = cst.ok
        ? solveLinkForces(geoOf(id), cst, st.cornerCh[id].contactPatch, tire, !isF)
        : null;
      const linkRec = links ?? { LCAF: NaN, LCAA: NaN, UCAF: NaN, UCAA: NaN, TOE: NaN, PR: NaN };
      rec[id] = { tire, links: linkRec, lifted: fz[id] < 0 };
      for (const l of LINK_NAMES) {
        const v = linkRec[l];
        if (Number.isFinite(v)) {
          peaks[id][l].min = Math.min(peaks[id][l].min, v);
          peaks[id][l].max = Math.max(peaks[id][l].max, v);
        }
      }
      tirePeaks[id].fzMin = Math.min(tirePeaks[id].fzMin, loaded[id]);
      tirePeaks[id].fzMax = Math.max(tirePeaks[id].fzMax, loaded[id]);
    }
    corners.push(rec);
  }

  return { samples, xLabel, poses, corners, peaks, tirePeaks, liftedSamples, info: geom };
}

export function forcesToCsv(res: ForceResult): string {
  const head: string[] = [res.xLabel, "ax_G", "ay_G"];
  for (const id of CORNERS) {
    for (const l of LINK_NAMES) head.push(`${id}_${l}_lbf`);
    head.push(`${id}_Fx_lbf`, `${id}_Fy_lbf`, `${id}_Fz_lbf`);
  }
  const rows = [head.join(",")];
  res.samples.forEach((s, i) => {
    const row: string[] = [String(s.t), s.ax.toFixed(4), s.ay.toFixed(4)];
    for (const id of CORNERS) {
      const c = res.corners[i][id];
      for (const l of LINK_NAMES) row.push(Number.isFinite(c.links[l]) ? c.links[l].toFixed(2) : "");
      row.push(c.tire[0].toFixed(2), c.tire[1].toFixed(2), c.tire[2].toFixed(2));
    }
    rows.push(row.join(","));
  });
  return rows.join("\n");
}
