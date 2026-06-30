// Corner-complex sector segmentation over lap-sim channel traces (roadmap
// #10). Pure observation — no solver involvement, no recalibration risk.
//
// Sector boundaries are the BRAKE APPLICATIONS: each transition into the
// "brake" limit state opens a new sector, so a sector reads as "the braking
// zone + the corner it serves + the following acceleration/straight" — the
// natural unit a race engineer reasons in ("T4 exit costs 0.2 s"). Tiny
// fragments (double brake stabs inside one complex) are merged forward into
// their neighbor so the table stays readable.

import type { LapChannels, LimitState } from "./lapSim";

export interface LapSector {
  /** 1-based sector number (S1…Sn from the start line). */
  idx: number;
  /** Distance range [startM, endM) on the lap. */
  startM: number;
  endM: number;
  /** Time spent in the sector (channel clock, incl. shift cuts inside it). */
  timeS: number;
  /** Minimum / maximum speed in the sector (km/h) — vMin is the apex. */
  vMinKph: number;
  vMaxKph: number;
  /** Time-weighted fraction of the sector in each limit state. */
  limitFrac: Partial<Record<LimitState, number>>;
  /** The state that dominates the sector's time. */
  dominant: LimitState;
}

/** Don't emit slivers: a brake stab closer than this to the previous boundary
 *  extends the current sector instead of opening a new one. */
const MIN_SECTOR_M = 40;

/** Channel sample i covers [distM[i], distM[i]+step) and tS[i] is the time at
 *  the segment's END — so the time at DISTANCE distM[i] is tS[i−1] (0 for the
 *  first). This builds the (distance → time) curve in that start-of-sample
 *  convention, with one extra point for the true lap end, so sector timing and
 *  cross-lap interpolation can never disagree by a sample. */
function distTimeCurve(ch: LapChannels): { xs: number[]; ys: number[] } {
  const n = ch.distM.length;
  const xs = new Array<number>(n + 1);
  const ys = new Array<number>(n + 1);
  for (let i = 0; i < n; i++) {
    xs[i] = ch.distM[i]!;
    ys[i] = i > 0 ? ch.tS[i - 1]! : 0;
  }
  const step = n > 1 ? ch.distM[1]! - ch.distM[0]! : 0;
  xs[n] = ch.distM[n - 1]! + step;
  ys[n] = ch.tS[n - 1]!;
  return { xs, ys };
}

function interpCurve(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]!) / Math.max(1e-12, xs[hi]! - xs[lo]!);
  return ys[lo]! + f * (ys[hi]! - ys[lo]!);
}

/** Segment a lap's channels into corner-complex sectors. Returns one sector
 *  covering the whole lap when it never brakes (a straight, a circle). */
export function lapSectors(ch: LapChannels): LapSector[] {
  const n = ch.distM.length;
  if (n === 0) return [];
  // Boundary indices: sample 0 plus every entry INTO "brake".
  const bounds: number[] = [0];
  for (let i = 1; i < n; i++) {
    if (ch.limit[i] === "brake" && ch.limit[i - 1] !== "brake") {
      const last = bounds[bounds.length - 1]!;
      if (ch.distM[i]! - ch.distM[last]! >= MIN_SECTOR_M) bounds.push(i);
    }
  }
  const curve = distTimeCurve(ch);
  const lapEndM = curve.xs[curve.xs.length - 1]!;
  // Merge a trailing sliver into the final sector.
  if (bounds.length > 1 && lapEndM - ch.distM[bounds[bounds.length - 1]!]! < MIN_SECTOR_M) {
    bounds.pop();
  }

  const sectors: LapSector[] = [];
  for (let s = 0; s < bounds.length; s++) {
    const i0 = bounds[s]!;
    const i1 = s + 1 < bounds.length ? bounds[s + 1]! : n; // exclusive
    let vMin = Infinity;
    let vMax = -Infinity;
    const stateDt: Partial<Record<LimitState, number>> = {};
    let dtSum = 0;
    for (let i = i0; i < i1; i++) {
      const v = ch.vMps[i]!;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
      const dt = ch.tS[i]! - (i > 0 ? ch.tS[i - 1]! : 0);
      stateDt[ch.limit[i]!] = (stateDt[ch.limit[i]!] ?? 0) + dt;
      dtSum += dt;
    }
    const limitFrac: Partial<Record<LimitState, number>> = {};
    let dominant: LimitState = "coast";
    let domDt = -1;
    for (const [k, v] of Object.entries(stateDt) as [LimitState, number][]) {
      limitFrac[k] = dtSum > 0 ? v / dtSum : 0;
      if (v > domDt) {
        domDt = v;
        dominant = k;
      }
    }
    // Sector boundaries in the start-of-sample convention (see distTimeCurve);
    // dtSum already equals t(end) − t(start) in the same convention.
    sectors.push({
      idx: s + 1,
      startM: ch.distM[i0]!,
      endM: i1 < n ? ch.distM[i1]! : lapEndM,
      timeS: dtSum,
      vMinKph: vMin * 3.6,
      vMaxKph: vMax * 3.6,
      limitFrac,
      dominant,
    });
  }
  return sectors;
}

/** Per-sector time delta of lap B vs lap A's sector boundaries (s; positive =
 *  B slower there). B's clock is read at A's boundary DISTANCES, so the two
 *  laps are compared over the same piece of road. */
export function sectorDeltas(sectorsA: LapSector[], chB: LapChannels): number[] {
  const { xs, ys } = distTimeCurve(chB);
  return sectorsA.map((s) => interpCurve(xs, ys, s.endM) - interpCurve(xs, ys, s.startM) - s.timeS);
}
