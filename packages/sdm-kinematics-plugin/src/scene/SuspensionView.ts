// Builds and updates the 3D suspension: links as line segments (colour-coded
// per member, COAST-style), hardpoints as small spheres, wheels as translucent
// cylinders + rim ring, plus roll-center / instant-center overlays. The
// member set is assembled per corner from that axle's SuspensionConfig, so
// MacPherson struts, five-link axles, direct coilovers, decoupling elements
// and U/Z-bars all draw what actually exists.

import * as THREE from "three";
import type { SceneManager } from "./SceneManager";
import type { V3 } from "../core/vec";
import { sub, unit, scale as vscale } from "../core/vec";
import { mirrorAxle, type AxleGeometry, type CarSetup, type CornerId, CORNERS } from "../core/model";
import type { CornerState } from "../core/solver";
import type { FullState } from "../core/sweep";

export const MEMBER_COLORS = {
  lca: 0x4ea1ff, // accent blue
  uca: 0x3ddc84, // green
  tie: 0xffb454, // amber
  push: 0xff6b6b, // red
  rocker: 0xc792ea, // violet
  shock: 0xffd866, // yellow
  ubar: 0x2dd4bf, // teal — U/Z-bar arm, droplink, and cross-bar
  element: 0xf28fad, // pink — third / roll decoupling elements
  upright: 0x93a0b4, // muted
  chassis: 0x2a313c,
} as const;

const NODE_COLOR = 0x9aa5b0;
const RC_COLOR = 0xff6b6b;
const IC_COLOR = 0x4ea1ff;

/** One drawable member: endpoints resolved from geometry + solved state. */
interface SegDef {
  color: keyof typeof MEMBER_COLORS;
  get(geo: AxleGeometry, st: CornerState): [V3, V3];
  /** Draw hardpoint spheres at the endpoints (default true). */
  spheres?: boolean;
}

/** Assemble the member list for an axle's configuration. */
function segmentDefs(cfg: AxleGeometry["config"]): SegDef[] {
  const defs: SegDef[] = [];
  if (cfg.type === "double-wishbone") {
    defs.push(
      { color: "lca", get: (g, st) => [g.lcaFront, st.p1] },
      { color: "lca", get: (g, st) => [g.lcaRear, st.p1] },
      { color: "uca", get: (g, st) => [g.ucaFront, st.p2] },
      { color: "uca", get: (g, st) => [g.ucaRear, st.p2] },
      { color: "tie", get: (_g, st) => [st.tieInner, st.p3] },
      { color: "upright", get: (_g, st) => [st.p1, st.p2] },
      { color: "upright", get: (_g, st) => [st.p1, st.p3] },
      { color: "upright", get: (_g, st) => [st.p2, st.p3] },
    );
  } else if (cfg.type === "macpherson") {
    defs.push(
      { color: "lca", get: (g, st) => [g.lcaFront, st.p1] },
      { color: "lca", get: (g, st) => [g.lcaRear, st.p1] },
      { color: "shock", get: (g, st) => [st.xform.apply(g.strutLower), g.strutTop] },
      { color: "tie", get: (_g, st) => [st.tieInner, st.p3] },
      { color: "upright", get: (g, st) => [st.p1, st.xform.apply(g.strutLower)] },
      { color: "upright", get: (_g, st) => [st.p1, st.p3] },
    );
  } else {
    defs.push(
      { color: "lca", get: (g, st) => [g.ml1In, st.xform.apply(g.ml1Out)] },
      { color: "lca", get: (g, st) => [g.ml2In, st.xform.apply(g.ml2Out)] },
      { color: "uca", get: (g, st) => [g.ml3In, st.xform.apply(g.ml3Out)] },
      { color: "uca", get: (g, st) => [g.ml4In, st.xform.apply(g.ml4Out)] },
      { color: "tie", get: (_g, st) => [st.tieInner, st.p3] },
      { color: "upright", get: (g, st) => [st.xform.apply(g.ml1Out), st.xform.apply(g.ml3Out)] },
      { color: "upright", get: (g, st) => [st.xform.apply(g.ml1Out), st.p3] },
    );
  }
  // Wheel spin axis (no spheres — the wheel mesh shows it).
  defs.push({ color: "upright", get: (_g, st) => [st.wheelCenter, st.wheelAxisOuter], spheres: false });

  const rodActuated = cfg.type !== "macpherson" &&
    (cfg.actuation === "pushrod-rocker" || cfg.actuation === "pullrod-rocker");
  if (rodActuated) {
    defs.push(
      { color: "push", get: (_g, st) => [st.pushLower, st.pushUpper] },
      { color: "rocker", get: (g, st) => [g.rockerAxis1, st.pushUpper] },
      { color: "rocker", get: (g, st) => [g.rockerAxis2, st.pushUpper] },
      { color: "rocker", get: (g, st) => [g.rockerAxis1, st.shockRocker] },
      { color: "rocker", get: (g, st) => [g.rockerAxis2, st.shockRocker] },
    );
  }
  if (cfg.type !== "macpherson") {
    defs.push({ color: "shock", get: (g, st) => [st.shockRocker, g.shockChassis] });
  }
  if (cfg.arb !== "none") {
    defs.push(
      { color: "ubar", get: (g, st) => [g.ubarPivot, st.ubarArm] },
      { color: "ubar", get: (_g, st) => [st.ubarArm, st.ubarNsma] },
      { color: "ubar", get: (g) => [g.ubarPivot, [g.ubarPivot[0], 0, g.ubarPivot[2]]], spheres: false },
    );
  }
  if (cfg.decoupling !== "none") {
    defs.push({ color: "element", get: (_g, st) => [st.thirdRocker, [st.thirdRocker[0], 0, st.thirdRocker[2]]] });
    if (cfg.decoupling === "heave-roll") {
      defs.push({ color: "element", get: (_g, st) => [st.rollRocker, [st.rollRocker[0], 0, st.rollRocker[2]]] });
    }
  }
  return defs;
}

interface CornerObjects {
  defs: SegDef[];
  lines: THREE.LineSegments;
  positions: Float32Array;
  nodes: THREE.Mesh[];
  wheel: THREE.Mesh;
  rim: THREE.Mesh;
  geo: AxleGeometry;
}

export class SuspensionView {
  private group = new THREE.Group();
  private overlay = new THREE.Group();
  private corners = new Map<CornerId, CornerObjects>();
  private smallSphereGeo = new THREE.SphereGeometry(0.45, 12, 12);
  private nodeMat = new THREE.MeshStandardMaterial({ color: NODE_COLOR, roughness: 0.55 });
  private rcMat = new THREE.MeshStandardMaterial({ color: RC_COLOR, roughness: 0.4 });
  private rcMarkers: THREE.Mesh[] = [];
  private icLines: THREE.LineSegments | null = null;
  private clearanceGroup = new THREE.Group();
  showOverlays = true;

  constructor(private sm: SceneManager, car: CarSetup) {
    this.car = car;
    sm.scene.add(this.group);
    sm.scene.add(this.overlay);
    sm.scene.add(this.clearanceGroup);
    this.setCar(car);
  }
  private car: CarSetup;

  /** Highlight a minimum-clearance location: markers at the two closest
   *  points plus the connecting gap line. */
  setClearanceMarker(pA: V3, pB: V3): void {
    this.clearClearanceMarker();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffb454, roughness: 0.3, emissive: 0x664400 });
    for (const p of [pA, pB]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 12), mat);
      m.position.copy(this.sm.toWorld(p));
      this.clearanceGroup.add(m);
    }
    const geo = new THREE.BufferGeometry().setFromPoints([this.sm.toWorld(pA), this.sm.toWorld(pB)]);
    this.clearanceGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffb454 })));
  }

  clearClearanceMarker(): void {
    this.clearanceGroup.clear();
  }

  setCar(car: CarSetup): void {
    this.car = car;
    this.build();
    // Keep the view centered on the car — OpK coordinates put the origin at
    // the front axle, so the car body lives at negative X.
    const f = car.front.wheelCenter, r = car.rear.wheelCenter;
    this.sm.focusOn(this.sm.toWorld([(f[0] + r[0]) / 2, 0, (f[2] + r[2]) / 2]));
  }

  private clear(): void {
    for (const obj of [...this.group.children]) this.group.remove(obj);
    this.overlay.clear();
    this.corners.clear();
    this.rcMarkers = [];
    this.icLines = null;
  }

  private build(): void {
    this.clear();
    const tireR = this.car.params.tireRadius;
    const tireW = this.car.params.tireWidth;
    const wheelGeo = new THREE.CylinderGeometry(tireR, tireR, tireW, 28, 1, true);
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x1f242d, roughness: 0.9, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const rimGeo = new THREE.TorusGeometry(tireR * 0.62, 0.35, 8, 24);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x93a0b4, roughness: 0.35, metalness: 0.6 });

    for (const id of CORNERS) {
      const geoL = id[0] === "F" ? this.car.front : this.car.rear;
      const geo = id[1] === "L" ? geoL : mirrorAxle(geoL);
      const defs = segmentDefs(geo.config);

      const positions = new Float32Array(defs.length * 2 * 3);
      const colors = new Float32Array(defs.length * 2 * 3);
      const c = new THREE.Color();
      defs.forEach((d, i) => {
        c.setHex(MEMBER_COLORS[d.color]);
        for (const k of [0, 1]) {
          colors[(i * 2 + k) * 3] = c.r;
          colors[(i * 2 + k) * 3 + 1] = c.g;
          colors[(i * 2 + k) * 3 + 2] = c.b;
        }
      });
      const bg = new THREE.BufferGeometry();
      bg.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      bg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const lines = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.group.add(lines);

      const nodes: THREE.Mesh[] = [];
      for (const d of defs) {
        if (d.spheres === false) continue;
        for (let k = 0; k < 2; k++) {
          const m = new THREE.Mesh(this.smallSphereGeo, this.nodeMat);
          nodes.push(m);
          this.group.add(m);
        }
      }

      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      this.group.add(wheel, rim);
      this.corners.set(id, { defs, lines, positions, nodes, wheel, rim, geo });
    }

    // Roll-center markers (front, rear).
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(this.smallSphereGeo, this.rcMat);
      this.rcMarkers.push(m);
      this.overlay.add(m);
    }
    // n-lines: 4 dashed segments (cp→IC each side, both axles).
    const icGeo = new THREE.BufferGeometry();
    icGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(4 * 2 * 3), 3));
    this.icLines = new THREE.LineSegments(
      icGeo,
      new THREE.LineDashedMaterial({ color: IC_COLOR, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.55 }),
    );
    this.overlay.add(this.icLines);
  }

  update(state: FullState): void {
    for (const id of CORNERS) {
      const objs = this.corners.get(id)!;
      const st = state.corners[id];
      let nodeIdx = 0;
      objs.defs.forEach((d, i) => {
        const [a, b] = d.get(objs.geo, st);
        const pa = this.sm.toWorld(a);
        const pb = this.sm.toWorld(b);
        objs.positions.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
        if (d.spheres !== false) {
          objs.nodes[nodeIdx++].position.copy(pa);
          objs.nodes[nodeIdx++].position.copy(pb);
        }
      });
      (objs.lines.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      objs.lines.geometry.computeBoundingSphere();

      // Wheel: cylinder axis (local Y) aligned to the wheel spin axis.
      const axis = unit(sub(st.wheelAxisOuter, st.wheelCenter));
      const wAxis = this.sm.toWorld(vscale(axis, 1)).sub(this.sm.toWorld([0, 0, 0]));
      objs.wheel.position.copy(this.sm.toWorld(st.wheelCenter));
      objs.wheel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), wAxis.normalize());
      objs.rim.position.copy(objs.wheel.position);
      objs.rim.quaternion.copy(objs.wheel.quaternion);
      objs.rim.rotateX(Math.PI / 2);
    }

    // Overlays: RC markers + n-lines at each axle's X station. Hidden when
    // the state was solved without axle probes (RC = NaN, e.g. animation).
    const rcFinite = Number.isFinite(state.frontAxle.rollCenter[1]);
    this.overlay.visible = this.showOverlays && rcFinite;
    if (this.showOverlays && rcFinite) {
      const axles = [
        { ch: state.frontAxle, x: this.car.front.wheelCenter[0], cpl: state.cornerCh.FL.contactPatch, cpr: state.cornerCh.FR.contactPatch },
        { ch: state.rearAxle, x: this.car.rear.wheelCenter[0], cpl: state.cornerCh.RL.contactPatch, cpr: state.cornerCh.RR.contactPatch },
      ];
      const icPos = (this.icLines!.geometry.getAttribute("position") as THREE.BufferAttribute);
      let seg = 0;
      axles.forEach((a, i) => {
        this.rcMarkers[i].position.copy(this.sm.toWorld([a.x, a.ch.rollCenter[0], a.ch.rollCenter[1]]));
        for (const [cp, ic] of [[a.cpl, a.ch.icLeft], [a.cpr, a.ch.icRight]] as const) {
          const from = this.sm.toWorld(cp as V3);
          const toPt: V3 = ic
            ? [a.x, ic[0], ic[1]]
            : [a.x, a.ch.rollCenter[0], a.ch.rollCenter[1]];
          const to = this.sm.toWorld(toPt);
          icPos.setXYZ(seg * 2, from.x, from.y, from.z);
          icPos.setXYZ(seg * 2 + 1, to.x, to.y, to.z);
          seg++;
        }
      });
      icPos.needsUpdate = true;
      this.icLines!.computeLineDistances();
    }
  }
}
