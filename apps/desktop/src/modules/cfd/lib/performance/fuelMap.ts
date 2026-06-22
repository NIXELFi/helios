// Physics-derived part-load fuel model (variable throttle) — ZERO calibration
// constants. The 1D solver's sweep already measures, per RPM at WOT:
//   - indicated power (combustion work) and brake power → their difference is
//     the friction + pumping power the engine pays before the crank,
//   - trapped air mass per cycle → WOT fuel flow via the config AFR,
// which is exactly a Willans line: fuel energy flow ≈ (P_brake_demand +
// P_friction(rpm)) / η_indicated(rpm). Demand below WOT (part throttle)
// burns proportionally less, but always pays the friction floor — so a
// design that must rev high at light load loses efficiency the way a real
// engine does, with no lumped thermal-efficiency knob.
//
// Honest limitation: η_indicated is taken load-independent (the WOT value),
// which UNDERSTATES part-throttle pumping losses of a throttled SI engine.
// FSAE restrictor engines spend race laps at mostly-open throttle, so the
// first-order Willans behavior dominates; treat absolute CO₂ with that grain
// of salt, rankings (its purpose) are robust.

import type { SweepPoint } from "../../state/types";

export interface EngineFuelMap {
  /** Ascending RPM grid. */
  rpms: number[];
  /** Friction + pumping power at WOT (kW): indicated − brake. */
  pFricKw: number[];
  /** Indicated thermal efficiency at WOT (0..1), vs the solver's fuel LHV. */
  etaInd: number[];
  /** WOT brake power (kW) — the demand ceiling at each rpm. */
  pWotKw: number[];
}

/** Solver-config fuel constants used to RECOVER fuel flow from trapped air:
 *  the shipped SDM26/25 configs run AFR 13.1 on 44 MJ/kg gasoline. η_ind is
 *  computed against these and is fuel-agnostic afterwards (energy-based), so
 *  the lap's actual fuel (Sunoco/E85 LHV) plugs in at evaluation time. */
const SOLVER_AFR = 13.1;
const SOLVER_LHV_J_KG = 44e6;

/** Build the fuel map from a sweep's per-RPM converged cycles. Returns null
 *  when the sweep lacks the needed channels (e.g. synthetic/dyno curves). */
export function fuelMapFromSweep(points: SweepPoint[]): EngineFuelMap | null {
  const rows = points
    .filter(
      (p) =>
        // Guard malformed/imported points missing `lastCycle` before deref.
        p?.lastCycle != null &&
        Number.isFinite(p.lastCycle.indicatedPowerKW) &&
        Number.isFinite(p.lastCycle.brakePowerKW) &&
        Number.isFinite(p.lastCycle.intakeMassPerCycleG) &&
        p.lastCycle.intakeMassPerCycleG > 0 &&
        p.rpm > 0,
    )
    .sort((a, b) => a.rpm - b.rpm);
  if (rows.length < 2) return null;
  const map: EngineFuelMap = { rpms: [], pFricKw: [], etaInd: [], pWotKw: [] };
  for (const p of rows) {
    // engine cycles per second (4-stroke: one engine cycle per 720° = 2 revs)
    const cyclesPerSec = p.rpm / 120;
    const fuelKgS = ((p.lastCycle.intakeMassPerCycleG / 1000) * cyclesPerSec) / SOLVER_AFR;
    const etaInd = (p.lastCycle.indicatedPowerKW * 1000) / (fuelKgS * SOLVER_LHV_J_KG);
    if (!Number.isFinite(etaInd) || etaInd <= 0.05 || etaInd > 0.6) continue;
    map.rpms.push(p.rpm);
    map.pFricKw.push(Math.max(0, p.lastCycle.indicatedPowerKW - p.lastCycle.brakePowerKW));
    map.etaInd.push(etaInd);
    map.pWotKw.push(Math.max(0, p.lastCycle.brakePowerKW));
  }
  return map.rpms.length >= 2 ? map : null;
}

function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
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

/** Willans fuel flow (kg/s) at engine speed `rpm` for a BRAKE power demand
 *  `pBrakeKw` (clamped to [0, WOT]) burning a fuel of `lhvJkg`. Zero demand
 *  still pays the friction floor (closed-throttle running; no DFCO). */
export function fuelFlowKgS(map: EngineFuelMap, rpm: number, pBrakeKw: number, lhvJkg: number): number {
  const pWot = interp(map.rpms, map.pWotKw, rpm);
  const dem = Math.min(Math.max(0, pBrakeKw), pWot);
  const pFric = interp(map.rpms, map.pFricKw, rpm);
  const eta = interp(map.rpms, map.etaInd, rpm);
  return ((dem + pFric) * 1000) / (eta * lhvJkg);
}
