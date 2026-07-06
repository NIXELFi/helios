// Clearance / motion study.
//
// Every link is a capsule (segment + link-OD radius); the tire is a solid
// cylinder. The study sweeps a full 4-D grid over heave × roll × pitch ×
// rack so EVERY extreme combination is visited (grid corners are the
// extremes; interior steps catch mid-travel pinch points), solves the car at
// each pose, and tracks the minimum clearance over all link↔link and
// link↔wheel pairs — with the pose, the pair, and the 3-D location of the
// closest approach. Pairs that are already touching at static (shared joints
// and bracket-mounted members) are excluded as "structurally adjacent".

import { type V3, add, sub, scale, dot, norm, unit } from "./vec";
import { mirrorAxle, type AxleGeometry, type CarSetup, type CornerId, CORNERS, type Pose } from "./model";
import { solveCar, cornerTargets } from "./sweep";
import type { CornerState } from "./solver";

export interface StudySegment {
  name: string;
  corner: CornerId;
  a: V3;
  b: V3;
  r: number; // capsule radius = OD/2
}

export interface WheelCyl {
  corner: CornerId;
  center: V3;
  axis: V3; // unit
  radius: number;
  halfWidth: number;
}

export interface ClearanceHit {
  kind: "link-link" | "link-wheel";
  aName: string;
  bName: string;
  corner: CornerId;
  clearance: number;
  /** Closest-approach points (surface-to-surface midpoint reported too). */
  pA: V3;
  pB: V3;
  location: V3;
  pose: Pose;
}

export interface StudyConfig {
  heaveRange: number;
  rollRange: number;
  pitchRange: number;
  rackRange: number;
  steps: number; // per axis, ≥2 covers the extremes
}

export interface StudyResult {
  posesChecked: number;
  solverFailures: number;
  /** Global minimum over the whole study. */
  min: ClearanceHit | null;
  /** Worst clearance seen per pair, sorted ascending. */
  worstPairs: ClearanceHit[];
  /** Coilover stop violations: pose + corner + shock length. */
  bottoming: { corner: CornerId; pose: Pose; shockLength: number; limit: string }[];
  pairsTracked: number;
  pairsExcluded: number;
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** Closest points between two segments (Ericson, Real-Time Collision
 *  Detection §5.1.9). Returns [pointOnA, pointOnB, distance]. */
export function segSegClosest(p1: V3, q1: V3, p2: V3, q2: V3): [V3, V3, number] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number, t: number;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const cA = add(p1, scale(d1, s));
  const cB = add(p2, scale(d2, t));
  return [cA, cB, norm(sub(cA, cB))];
}

/** Signed distance from a point to a finite solid cylinder's surface
 *  (negative = inside), plus the nearest surface point (approximate for
 *  interior points). */
function pointCylinder(p: V3, cyl: WheelCyl): { d: number; surf: V3 } {
  const v = sub(p, cyl.center);
  const ax = dot(v, cyl.axis);
  const radial = sub(v, scale(cyl.axis, ax));
  const r = norm(radial);
  const rDir = r > 1e-9 ? scale(radial, 1 / r) : unit([cyl.axis[2], 0, -cyl.axis[0]]);
  const dr = r - cyl.radius;
  const da = Math.abs(ax) - cyl.halfWidth;
  if (dr <= 0 && da <= 0) {
    // inside — penetration depth is the smaller escape
    const d = Math.max(dr, da);
    const surf = dr > da
      ? add(add(cyl.center, scale(cyl.axis, ax)), scale(rDir, cyl.radius))
      : add(add(cyl.center, scale(cyl.axis, Math.sign(ax) * cyl.halfWidth)), scale(rDir, r));
    return { d, surf };
  }
  const clampedAx = Math.min(cyl.halfWidth, Math.max(-cyl.halfWidth, ax));
  const clampedR = Math.min(cyl.radius, r);
  const surf = add(add(cyl.center, scale(cyl.axis, clampedAx)), scale(rDir, Math.max(dr, 0) > 0 ? cyl.radius : clampedR));
  return { d: Math.hypot(Math.max(dr, 0), Math.max(da, 0)), surf };
}

/** Min clearance between a capsule (segment, radius) and the tire cylinder,
 *  by sampling along the segment. */
function segCylinderClearance(seg: StudySegment, cyl: WheelCyl): { d: number; pA: V3; pB: V3 } {
  const N = 12;
  let best = { d: Infinity, pA: seg.a, pB: seg.a };
  for (let i = 0; i <= N; i++) {
    const p = add(seg.a, scale(sub(seg.b, seg.a), i / N));
    const { d, surf } = pointCylinder(p, cyl);
    if (d < best.d) best = { d, pA: p, pB: surf };
  }
  return { d: best.d - seg.r, pA: best.pA, pB: best.pB };
}

// ---------------------------------------------------------------------------
// Study body assembly
// ---------------------------------------------------------------------------

export function buildSegments(car: CarSetup, corner: CornerId, st: CornerState): StudySegment[] {
  const geoL = corner[0] === "F" ? car.front : car.rear;
  const geo = corner[1] === "L" ? geoL : mirrorAxle(geoL);
  const od = geo.linkOD;
  const cfg = geo.config;
  const mk = (name: string, a: V3, b: V3, d: number): StudySegment =>
    ({ name, corner, a, b, r: d / 2 });
  const xf = st.xform;
  const segs: StudySegment[] = [];

  if (cfg.type === "double-wishbone") {
    segs.push(
      mk("LCA fore", geo.lcaFront, st.p1, od.lca),
      mk("LCA aft", geo.lcaRear, st.p1, od.lca),
      mk("UCA fore", geo.ucaFront, st.p2, od.uca),
      mk("UCA aft", geo.ucaRear, st.p2, od.uca),
      mk("toe link", st.tieInner, st.p3, od.tie),
    );
  } else if (cfg.type === "macpherson") {
    segs.push(
      mk("LCA fore", geo.lcaFront, st.p1, od.lca),
      mk("LCA aft", geo.lcaRear, st.p1, od.lca),
      mk("strut", xf.apply(geo.strutLower), geo.strutTop, od.shock),
      mk("toe link", st.tieInner, st.p3, od.tie),
    );
  } else {
    const links: [string, V3, V3, number][] = [
      ["link 1", geo.ml1In, xf.apply(geo.ml1Out), od.lca],
      ["link 2", geo.ml2In, xf.apply(geo.ml2Out), od.lca],
      ["link 3", geo.ml3In, xf.apply(geo.ml3Out), od.uca],
      ["link 4", geo.ml4In, xf.apply(geo.ml4Out), od.uca],
      ["link 5 (toe)", st.tieInner, st.p3, od.tie],
    ];
    for (const [n, a, b, d] of links) segs.push(mk(n, a, b, d));
  }

  const rodActuated = cfg.type !== "macpherson" &&
    (cfg.actuation === "pushrod-rocker" || cfg.actuation === "pullrod-rocker");
  if (rodActuated) segs.push(mk("pushrod", st.pushLower, st.pushUpper, od.push));
  if (cfg.type !== "macpherson") {
    segs.push(mk("coilover", st.shockRocker, geo.shockChassis, od.shock));
  }
  if (cfg.arb !== "none") {
    segs.push(
      mk("droplink", st.ubarNsma, st.ubarArm, od.droplink),
      mk("U-bar arm", geo.ubarPivot, st.ubarArm, od.droplink),
    );
  }
  if (cfg.decoupling !== "none") {
    // Elements run to the mirrored pickup — represent the near half so the
    // clearance check sees the member without double-counting across sides.
    const mid3: V3 = [st.thirdRocker[0], 0, st.thirdRocker[2]];
    segs.push(mk("3rd element", st.thirdRocker, mid3, od.shock));
    if (cfg.decoupling === "heave-roll") {
      const midR: V3 = [st.rollRocker[0], 0, st.rollRocker[2]];
      segs.push(mk("roll element", st.rollRocker, midR, od.shock));
    }
  }
  return segs;
}

export function buildWheel(car: CarSetup, corner: CornerId, st: CornerState): WheelCyl {
  return {
    corner,
    center: st.wheelCenter,
    axis: unit(sub(st.wheelAxisOuter, st.wheelCenter)),
    radius: car.params.tireRadius,
    halfWidth: car.params.tireWidth / 2,
  };
}

const sharesJoint = (s1: StudySegment, s2: StudySegment): boolean => {
  const close = (a: V3, b: V3) => norm(sub(a, b)) < 1e-6;
  return close(s1.a, s2.a) || close(s1.a, s2.b) || close(s1.b, s2.a) || close(s1.b, s2.b);
};

// ---------------------------------------------------------------------------
// The study
// ---------------------------------------------------------------------------

export interface StudyHandle {
  cancel(): void;
  done: Promise<StudyResult>;
}

export function runClearanceStudy(
  car: CarSetup,
  cfg: StudyConfig,
  onProgress: (done: number, total: number) => void,
): StudyHandle {
  const steps = Math.max(2, Math.round(cfg.steps));
  const axis = (range: number) => {
    if (range <= 0) return [0];
    const out: number[] = [];
    for (let i = 0; i < steps; i++) out.push(-range + (2 * range * i) / (steps - 1));
    return out;
  };
  const heaves = axis(cfg.heaveRange);
  const rolls = axis(cfg.rollRange);
  const pitches = axis(cfg.pitchRange);
  const racks = axis(cfg.rackRange);
  const poses: Pose[] = [];
  for (const h of heaves) for (const ro of rolls) for (const pi of pitches) for (const ra of racks) {
    poses.push({ heave: h, rollDeg: ro, pitchDeg: pi, rack: ra });
  }

  // Static exclusion map: pairs already inside the threshold at static are
  // structurally adjacent (bracket mounts, shared bearings) — not findings.
  const ADJACENT_TOL = 0.05;
  const staticState = solveCar(car, { heave: 0, rollDeg: 0, pitchDeg: 0, rack: 0 }, undefined, {
    cornerProbes: false, axleProbes: false,
  });
  const excluded = new Set<string>();
  let pairsTracked = 0;
  for (const corner of CORNERS) {
    const segs = buildSegments(car, corner, staticState.corners[corner]);
    const wheel = buildWheel(car, corner, staticState.corners[corner]);
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const key = `${corner}|${segs[i].name}|${segs[j].name}`;
        if (sharesJoint(segs[i], segs[j])) { excluded.add(key); continue; }
        const [, , d] = segSegClosest(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
        if (d - segs[i].r - segs[j].r < ADJACENT_TOL) excluded.add(key);
        else pairsTracked++;
      }
      const wKey = `${corner}|${segs[i].name}|wheel`;
      const { d } = segCylinderClearance(segs[i], wheel);
      if (d < ADJACENT_TOL) excluded.add(wKey);
      else pairsTracked++;
    }
  }

  let cancelled = false;
  const done = new Promise<StudyResult>((resolve) => {
    const worst = new Map<string, ClearanceHit>();
    const bottoming: StudyResult["bottoming"] = [];
    let failures = 0;
    let idx = 0;
    let warm: Record<CornerId, CornerState> | undefined;

    const CHUNK = 24;
    const step = () => {
      const end = Math.min(idx + CHUNK, poses.length);
      for (; idx < end; idx++) {
        const pose = poses[idx];
        const st = solveCar(car, pose, warm, { cornerProbes: false, axleProbes: false });
        const allOk = CORNERS.every((id) => st.corners[id].ok);
        if (!allOk) { failures++; warm = undefined; continue; }
        warm = st.corners;

        for (const corner of CORNERS) {
          const cst = st.corners[corner];
          // Coilover stop check.
          const isFront = corner[0] === "F";
          const lo = isFront ? car.params.coilMinFront : car.params.coilMinRear;
          const hi = isFront ? car.params.coilMaxFront : car.params.coilMaxRear;
          if (cst.shockLength < lo || cst.shockLength > hi) {
            if (bottoming.length < 50) {
              bottoming.push({
                corner, pose, shockLength: cst.shockLength,
                limit: cst.shockLength < lo ? `< min ${lo}` : `> max ${hi}`,
              });
            }
          }

          const segs = buildSegments(car, corner, cst);
          const wheel = buildWheel(car, corner, cst);
          const record = (key: string, hit: ClearanceHit) => {
            const cur = worst.get(key);
            if (!cur || hit.clearance < cur.clearance) worst.set(key, hit);
          };
          for (let i = 0; i < segs.length; i++) {
            for (let j = i + 1; j < segs.length; j++) {
              const key = `${corner}|${segs[i].name}|${segs[j].name}`;
              if (excluded.has(key)) continue;
              const [pA, pB, d] = segSegClosest(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
              const clearance = d - segs[i].r - segs[j].r;
              record(key, {
                kind: "link-link", aName: segs[i].name, bName: segs[j].name, corner,
                clearance, pA, pB, location: scale(add(pA, pB), 0.5), pose,
              });
            }
            const wKey = `${corner}|${segs[i].name}|wheel`;
            if (excluded.has(wKey)) continue;
            const { d, pA, pB } = segCylinderClearance(segs[i], wheel);
            record(wKey, {
              kind: "link-wheel", aName: segs[i].name, bName: "wheel", corner,
              clearance: d, pA, pB, location: scale(add(pA, pB), 0.5), pose,
            });
          }
        }
      }
      onProgress(idx, poses.length);
      if (idx >= poses.length || cancelled) {
        const hits = [...worst.values()].sort((a, b) => a.clearance - b.clearance);
        resolve({
          posesChecked: idx,
          solverFailures: failures,
          min: hits[0] ?? null,
          worstPairs: hits.slice(0, 12),
          bottoming,
          pairsTracked,
          pairsExcluded: excluded.size,
        });
        return;
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });

  return { cancel: () => { cancelled = true; }, done };
}

/** Human label for the motion condition of a hit. */
export function poseLabel(p: Pose): string {
  const parts: string[] = [];
  if (p.heave !== 0) parts.push(`heave ${p.heave.toFixed(2)}"`);
  if (p.rollDeg !== 0) parts.push(`roll ${p.rollDeg.toFixed(2)}°`);
  if (p.pitchDeg !== 0) parts.push(`pitch ${p.pitchDeg.toFixed(2)}°`);
  if (p.rack !== 0) parts.push(`rack ${p.rack.toFixed(2)}"`);
  return parts.length ? parts.join(" · ") : "static";
}
