// Vehicle-dynamics parameter sweep for the lap sim. Sweep ONE chassis knob —
// total mass, CG height, ARB balance (RSD front share), or tire μ %dropoff —
// across a range and re-run the FULL `simLap` at each value, reporting lap time,
// peak lateral g, axle balance margin, and fuel. The grip model already carries
// the physics (load-sensitive μ, lateral load transfer χ, per-axle roll split);
// this is the thin driver + the %dropoff↔sens framing that puts it on screen,
// mirroring fdOptimizer.ts / sensitivity.ts.
//
// IDENTITY-CLOBBER TRAP (cfd-roadmap.md:24-26, vehicle.ts:170-177): `vehicleForCar`
// FORCE-overwrites identity keys (incl. massKg) for known cars. So `applyVdParam`
// patches an ALREADY-RESOLVED VehicleConfig and NEVER routes back through
// vehicleForCar — callers must resolve the baseline vehicle first, then sweep.
// A mass sweep applied before identity resolution silently resets to the preset.

import type { VehicleConfig } from "./types";
import type { TorqueCurve } from "./torqueCurve";
import type { Track } from "./track";
import { simLap, type LapOpts } from "./lapSim";
import { sensFromDropoffPct } from "./loadSensitivity";

/** The vehicle-dynamics knobs the lap-sim VD sweep can vary. `muDropoffPct` is
 *  the display framing of `tireLoadSensitivity` (see loadSensitivity.ts) — the
 *  ONLY param that's invalid when a measured `.tir` overrides μ(Fz). */
export type VdParam = "massKg" | "cgHeightM" | "rsdFront" | "muDropoffPct";

/** Stable order for the UI dropdown. */
export const VD_PARAMS: VdParam[] = ["massKg", "cgHeightM", "rsdFront", "muDropoffPct"];

/** Human labels + units for the UI / CSV header. */
export const VD_PARAM_META: Record<VdParam, { label: string; unit: string }> = {
  massKg: { label: "Total mass", unit: "kg" },
  cgHeightM: { label: "CG height", unit: "m" },
  rsdFront: { label: "ARB balance (RSD front)", unit: "frac" },
  muDropoffPct: { label: "Tire µ drop / doubling", unit: "%" },
};

/** Physical default sweep windows (NOT arbitrary 0..1). RSD spans the team's
 *  ARB-calculator range; %dropoff spans tireLoadSensitivity 0–0.3; mass/CG are
 *  sensible deltas around the SDM26 preset. UI seeds the controls from these. */
export const VD_PARAM_RANGE: Record<VdParam, { start: number; stop: number; step: number }> = {
  massKg: { start: 250, stop: 300, step: 5 },
  cgHeightM: { start: 0.24, stop: 0.34, step: 0.01 },
  rsdFront: { start: 0.376, stop: 0.605, step: 0.02 }, // vehicle.ts:11-12
  muDropoffPct: { start: 0, stop: 20, step: 2 }, // sens 0–~0.32
};

export interface VdSweepSpec {
  param: VdParam;
  /** Inclusive sweep bounds in the param's native unit (%dropoff for µ). */
  start: number;
  stop: number;
  /** Step magnitude (>0). */
  step: number;
}

export interface VdSweepRow {
  /** The swept value in the param's native unit. */
  value: number;
  lapTimeS: number;
  maxLatG: number;
  /** Signed axle-capacity margin (roll model only); undefined otherwise. */
  balanceMargin?: number;
  fuelKg: number;
}

/** Patch a RESOLVED vehicle for one VD-sweep param value. Returns a NEW config
 *  (input untouched). `muDropoffPct` is converted to the stored
 *  `tireLoadSensitivity` exponent; `rsdFront` patches the roll config in place
 *  (when present). Never goes through vehicleForCar — see the file header. */
export function applyVdParam(v: VehicleConfig, param: VdParam, x: number): VehicleConfig {
  switch (param) {
    case "massKg":
      return { ...v, massKg: x };
    case "cgHeightM":
      return { ...v, cgHeightM: x };
    case "rsdFront":
      // No roll config → nothing to balance; leave the lumped model alone.
      return v.roll ? { ...v, roll: { ...v.roll, rsdFront: x } } : v;
    case "muDropoffPct":
      return { ...v, tireLoadSensitivity: sensFromDropoffPct(x) };
    default: {
      const _exhaustive: never = param;
      return _exhaustive;
    }
  }
}

/** Inclusive value grid for a sweep spec, robust to float step drift. */
export function vdSweepValues(spec: VdSweepSpec): number[] {
  const step = Math.abs(spec.step) || 1;
  const lo = Math.min(spec.start, spec.stop);
  const hi = Math.max(spec.start, spec.stop);
  const n = Math.floor((hi - lo) / step + 1e-9);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(Number((lo + i * step).toFixed(6)));
  return out;
}

/** Run the sweep: at each value, patch the (already-resolved) base vehicle and
 *  re-run the full lap. `opts` is the SAME LapOpts the screen's baseline run
 *  uses (pace / lineFactor / fuel), so the sweep and the A/B study agree. */
export function runVdSweep(
  curve: TorqueCurve,
  baseVehicle: VehicleConfig,
  track: Track,
  spec: VdSweepSpec,
  opts: LapOpts = {},
): VdSweepRow[] {
  return vdSweepValues(spec).map((value) => {
    const res = simLap(curve, applyVdParam(baseVehicle, spec.param, value), track, opts);
    return {
      value,
      lapTimeS: res.lapTimeS,
      maxLatG: res.telemetry.maxLatG,
      ...(res.telemetry.balanceMargin !== undefined
        ? { balanceMargin: res.telemetry.balanceMargin }
        : {}),
      fuelKg: res.fuelKg,
    };
  });
}
