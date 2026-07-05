// Sweep engine: drives the four corner solvers through heave / roll / pitch /
// steer motions (OptimumK's "motion" concept) and records every output
// channel at each step, warm-starting each solve from the previous step.

import { mirrorAxle, trackWidth, wheelbase, type CarSetup, type CornerId, type Pose } from "./model";
import { solveCorner, type CornerState } from "./solver";
import { cornerChannels, axleChannels, ackermannPct, type CornerChannels, type AxleChannels } from "./channels";
import { rad } from "./vec";

export type SweepType = "heave" | "roll" | "pitch" | "steer";

export interface SweepSpec {
  type: SweepType;
  /** Symmetric range: sweep runs −range … +range. Units: in (heave), deg
   *  (roll/pitch), in of rack travel (steer). */
  range: number;
  steps: number;
}

export interface FullState {
  corners: Record<CornerId, CornerState>;
  cornerCh: Record<CornerId, CornerChannels>;
  frontAxle: AxleChannels;
  rearAxle: AxleChannels;
  ackermann: number | null;
  pose: Pose;
}

/** Per-corner bump target (wheel Δz relative to chassis) for an attitude.
 *  Pitch rotates about mid-wheelbase so the math is origin-independent
 *  (OptimumK files put the origin at the front axle, not mid-wheelbase). */
export function cornerTargets(car: CarSetup, pose: Pose): Record<CornerId, number> {
  const tf = Math.tan(rad(pose.rollDeg));
  const tp = Math.tan(rad(pose.pitchDeg));
  const f = car.front.wheelCenter, r = car.rear.wheelCenter;
  const xMid = (f[0] + r[0]) / 2;
  const dz = (x: number, y: number) => pose.heave - y * tf + (x - xMid) * tp;
  return {
    FL: dz(f[0], f[1]),
    FR: dz(f[0], -f[1]),
    RL: dz(r[0], r[1]),
    RR: dz(r[0], -r[1]),
  };
}

/** Evaluation cost controls — the optimizer skips derivative-probe solves
 *  for channels a study doesn't reference. */
export interface EvalOpts {
  cornerProbes?: boolean; // installation ratio / wheel rate
  axleProbes?: boolean; // RC, ICs, anti%, bump steer, camber gain
}

/** Solve the whole car at one attitude. `warm` carries the previous step's
 *  solution for sweep continuity. */
export function solveCar(
  car: CarSetup, pose: Pose, warm?: Record<CornerId, CornerState>, opts?: EvalOpts,
): FullState {
  const cornerProbes = opts?.cornerProbes ?? true;
  const axleProbes = opts?.axleProbes ?? true;
  const targets = cornerTargets(car, pose);
  const geoFL = car.front;
  const geoFR = mirrorAxle(car.front);
  const geoRL = car.rear;
  const geoRR = mirrorAxle(car.rear);
  const g = (id: CornerId) => (id === "FL" ? geoFL : id === "FR" ? geoFR : id === "RL" ? geoRL : geoRR);

  const corners = {} as Record<CornerId, CornerState>;
  for (const id of ["FL", "FR", "RL", "RR"] as CornerId[]) {
    const isFront = id[0] === "F";
    const rack = isFront ? pose.rack : 0;
    const w = warm?.[id];
    corners[id] = solveCorner({
      geo: g(id),
      dz: targets[id],
      rack,
      guess: w ? [w.p1, w.p2, w.p3] : undefined,
    });
  }

  const p = car.params;
  const cornerCh = {} as Record<CornerId, CornerChannels>;
  (["FL", "FR", "RL", "RR"] as CornerId[]).forEach((id) => {
    const isFront = id[0] === "F";
    const side = id[1] === "L" ? 1 : -1;
    cornerCh[id] = cornerChannels(
      g(id), corners[id], side as 1 | -1, p,
      isFront ? p.springRateFront : p.springRateRear,
      targets[id], isFront ? pose.rack : 0,
      !cornerProbes,
    );
  });

  const wb = wheelbase(car);
  const frontAxle = axleChannels(
    geoFL, geoFR, p, corners.FL, corners.FR, targets.FL, targets.FR, pose.rack, true, wb, !axleProbes,
  );
  const rearAxle = axleChannels(
    geoRL, geoRR, p, corners.RL, corners.RR, targets.RL, targets.RR, 0, false, wb, !axleProbes,
  );

  return {
    corners, cornerCh, frontAxle, rearAxle,
    ackermann: ackermannPct(cornerCh.FL.steer, cornerCh.FR.steer, trackWidth(car.front), wb),
    pose,
  };
}

export interface SweepResult {
  spec: SweepSpec;
  paramLabel: string;
  paramUnit: string;
  values: number[];
  /** channel key → series (same length as values). */
  series: Map<string, number[]>;
  states: FullState[];
}

export interface ChannelDef {
  key: string;
  label: string;
  unit: string;
  /** Extract per-state value. */
  get(s: FullState): number | null;
  defaultOn?: boolean;
}

const corner = (id: CornerId, f: (c: CornerChannels) => number, label: string, unit: string, on = false): ChannelDef => ({
  key: `${label.toLowerCase().replace(/[^a-z]+/g, "_")}_${id}`,
  label: `${label} ${id}`,
  unit,
  get: (s) => f(s.cornerCh[id]),
  defaultOn: on,
});

export function channelDefs(): ChannelDef[] {
  const defs: ChannelDef[] = [];
  const ids: CornerId[] = ["FL", "FR", "RL", "RR"];
  for (const id of ids) defs.push(corner(id, (c) => c.camber, "Camber", "deg", id === "FL" || id === "FR"));
  for (const id of ids) defs.push(corner(id, (c) => c.toe, "Toe", "deg", id === "FL" || id === "FR"));
  for (const id of ids) defs.push(corner(id, (c) => c.caster, "Caster", "deg"));
  for (const id of ids) defs.push(corner(id, (c) => c.kpi, "KPI", "deg"));
  for (const id of ids) defs.push(corner(id, (c) => c.mechTrail, "Mech trail", "in"));
  for (const id of ids) defs.push(corner(id, (c) => c.scrub, "Scrub radius", "in"));
  for (const id of ids) defs.push(corner(id, (c) => c.installRatio, "Install ratio", "in/in"));
  for (const id of ids) defs.push(corner(id, (c) => c.wheelRate, "Wheel rate", "lb/in"));
  for (const id of ids) defs.push(corner(id, (c) => c.shockLength, "Shock length", "in"));
  for (const id of ids) defs.push(corner(id, (c) => c.steer, "Steer angle", "deg"));
  defs.push(
    { key: "rc_height_f", label: "Roll center height F", unit: "in", get: (s) => s.frontAxle.rollCenter[1], defaultOn: true },
    { key: "rc_height_r", label: "Roll center height R", unit: "in", get: (s) => s.rearAxle.rollCenter[1], defaultOn: true },
    { key: "rc_lat_f", label: "Roll center lateral F", unit: "in", get: (s) => s.frontAxle.rollCenter[0] },
    { key: "rc_lat_r", label: "Roll center lateral R", unit: "in", get: (s) => s.rearAxle.rollCenter[0] },
    { key: "anti_dive", label: "Anti-dive F", unit: "%", get: (s) => s.frontAxle.antiPct },
    { key: "anti_squat", label: "Anti-squat R", unit: "%", get: (s) => s.rearAxle.antiPct },
    { key: "bump_steer_fl", label: "Bump steer FL", unit: "deg/in", get: (s) => s.frontAxle.bumpSteerLeft },
    { key: "camber_gain_fl", label: "Camber gain FL", unit: "deg/in", get: (s) => s.frontAxle.camberGainLeft },
    { key: "ackermann", label: "Ackermann", unit: "%", get: (s) => s.ackermann },
  );
  return defs;
}

const SWEEP_META: Record<SweepType, { label: string; unit: string }> = {
  heave: { label: "Heave", unit: "in" },
  roll: { label: "Roll", unit: "deg" },
  pitch: { label: "Pitch", unit: "deg" },
  steer: { label: "Rack travel", unit: "in" },
};

export function runSweep(car: CarSetup, spec: SweepSpec, opts?: EvalOpts): SweepResult {
  const n = Math.max(3, Math.floor(spec.steps));
  const values: number[] = [];
  const states: FullState[] = [];
  const defs = channelDefs();
  const series = new Map<string, number[]>(defs.map((d) => [d.key, []]));

  // March out from zero in both directions so every solve warm-starts from a
  // neighbour — Newton stays on the correct assembly branch at big travels.
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(-spec.range + (2 * spec.range * i) / (n - 1));
  const order = raw
    .map((v, i) => ({ v, i }))
    .sort((a, b) => Math.abs(a.v) - Math.abs(b.v));

  const stateAt: FullState[] = new Array(n);
  let warmPos: Record<CornerId, CornerState> | undefined;
  let warmNeg: Record<CornerId, CornerState> | undefined;
  for (const { v, i } of order) {
    const pose: Pose = { heave: 0, rollDeg: 0, pitchDeg: 0, rack: 0 };
    if (spec.type === "heave") pose.heave = v;
    else if (spec.type === "roll") pose.rollDeg = v;
    else if (spec.type === "pitch") pose.pitchDeg = v;
    else pose.rack = v;
    const warm = v >= 0 ? warmPos : warmNeg;
    const st = solveCar(car, pose, warm, opts);
    if (v >= 0) warmPos = st.corners;
    if (v <= 0) warmNeg = st.corners;
    stateAt[i] = st;
  }

  for (let i = 0; i < n; i++) {
    values.push(raw[i]);
    states.push(stateAt[i]);
    for (const d of defs) {
      const val = d.get(stateAt[i]);
      series.get(d.key)!.push(val === null ? NaN : val);
    }
  }

  return {
    spec,
    paramLabel: SWEEP_META[spec.type].label,
    paramUnit: SWEEP_META[spec.type].unit,
    values,
    series,
    states,
  };
}
