// Builds and updates the 3D suspension: links as line segments (colour-coded
// per member, COAST-style), hardpoints as small spheres, wheels as translucent
// cylinders + rim ring, plus roll-center / instant-center overlays.

import * as THREE from "three";
import type { SceneManager } from "./SceneManager";
import type { V3 } from "../core/vec";
import { sub, unit, scale as vscale } from "../core/vec";
import { mirrorAxle, type CarSetup, type CornerId, CORNERS } from "../core/model";
import type { FullState } from "../core/sweep";

export const MEMBER_COLORS = {
  lca: 0x4ea1ff, // accent blue
  uca: 0x3ddc84, // green
  tie: 0xffb454, // amber
  push: 0xff6b6b, // red
  rocker: 0xc792ea, // violet
  shock: 0xffd866, // yellow
  upright: 0x93a0b4, // muted
  chassis: 0x2a313c,
} as const;

const NODE_COLOR = 0x9aa5b0;
const RC_COLOR = 0xff6b6b;
const IC_COLOR = 0x4ea1ff;

interface CornerObjects {
  lines: THREE.LineSegments;
  positions: Float32Array;
  nodes: THREE.Mesh[];
  nodePts: V3[];
  wheel: THREE.Mesh;
  rim: THREE.Mesh;
}

export class SuspensionView {
  private group = new THREE.Group();
  private overlay = new THREE.Group();
  private corners = new Map<CornerId, CornerObjects>();
  private sphereGeo = new THREE.SphereGeometry(0.6, 14, 14);
  private smallSphereGeo = new THREE.SphereGeometry(0.45, 12, 12);
  private nodeMat = new THREE.MeshStandardMaterial({ color: NODE_COLOR, roughness: 0.55 });
  private rcMat = new THREE.MeshStandardMaterial({ color: RC_COLOR, roughness: 0.4 });
  private rcMarkers: THREE.Mesh[] = [];
  private icLines: THREE.LineSegments | null = null;
  showOverlays = true;

  constructor(private sm: SceneManager, private car: CarSetup) {
    sm.scene.add(this.group);
    sm.scene.add(this.overlay);
    this.build();
  }

  setCar(car: CarSetup): void {
    this.car = car;
    this.build();
  }

  private clear(): void {
    for (const obj of [...this.group.children]) this.group.remove(obj);
    this.overlay.clear();
    this.corners.clear();
    this.rcMarkers = [];
    this.icLines = null;
  }

  /** Members drawn per corner, as index pairs into the 10-point layout below. */
  private static SEGMENTS: [number, number, keyof typeof MEMBER_COLORS][] = [
    [0, 2, "lca"], [1, 2, "lca"],
    [3, 5, "uca"], [4, 5, "uca"],
    [6, 7, "tie"],
    [8, 9, "push"],
    [10, 12, "rocker"], [11, 12, "rocker"], [10, 13, "rocker"], [11, 13, "rocker"],
    [13, 14, "shock"],
    [2, 5, "upright"], [2, 7, "upright"], [5, 7, "upright"],
    [15, 16, "upright"],
  ];

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
      const segCount = SuspensionView.SEGMENTS.length;
      const positions = new Float32Array(segCount * 2 * 3);
      const colors = new Float32Array(segCount * 2 * 3);
      const c = new THREE.Color();
      SuspensionView.SEGMENTS.forEach(([, , mkey], i) => {
        c.setHex(MEMBER_COLORS[mkey]);
        for (const k of [0, 1]) {
          colors[(i * 2 + k) * 3] = c.r;
          colors[(i * 2 + k) * 3 + 1] = c.g;
          colors[(i * 2 + k) * 3 + 2] = c.b;
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.group.add(lines);

      const nodes: THREE.Mesh[] = [];
      for (let i = 0; i < 15; i++) {
        const m = new THREE.Mesh(i < 10 ? this.sphereGeo : this.smallSphereGeo, this.nodeMat);
        nodes.push(m);
        this.group.add(m);
      }

      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      this.group.add(wheel, rim);

      this.corners.set(id, { lines, positions, nodes, nodePts: [], wheel, rim });
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

  /** Point layout per corner (car coords):
   *  0 lcaFront 1 lcaRear 2 LBJ 3 ucaFront 4 ucaRear 5 UBJ 6 tieInner
   *  7 tieOuter 8 pushLower 9 pushUpper 10 rockerAxis1 11 rockerAxis2
   *  12 pushUpper(rocker) 13 shockRocker 14 shockChassis 15 wc 16 axisOuter */
  update(state: FullState): void {
    for (const id of CORNERS) {
      const objs = this.corners.get(id)!;
      const st = state.corners[id];
      const geo = id.endsWith("L")
        ? (id[0] === "F" ? this.car.front : this.car.rear)
        : mirrorAxle(id[0] === "F" ? this.car.front : this.car.rear);

      const pts: V3[] = [
        geo.lcaFront, geo.lcaRear, st.p1,
        geo.ucaFront, geo.ucaRear, st.p2,
        st.tieInner, st.p3,
        st.pushLower, st.pushUpper,
        geo.rockerAxis1, geo.rockerAxis2, st.pushUpper, st.shockRocker, geo.shockChassis,
        st.wheelCenter, st.wheelAxisOuter,
      ];
      objs.nodePts = pts;

      SuspensionView.SEGMENTS.forEach(([a, b], i) => {
        const pa = this.sm.toWorld(pts[a]);
        const pb = this.sm.toWorld(pts[b]);
        objs.positions.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
      });
      (objs.lines.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      objs.lines.geometry.computeBoundingSphere();

      // Hardpoint spheres (skip wc/axisOuter — the wheel shows those).
      for (let i = 0; i < 15; i++) objs.nodes[i].position.copy(this.sm.toWorld(pts[i]));

      // Wheel: cylinder axis (local Y) aligned to the wheel spin axis.
      const axis = unit(sub(st.wheelAxisOuter, st.wheelCenter));
      const wAxis = this.sm.toWorld(vscale(axis, 1)).sub(this.sm.toWorld([0, 0, 0]));
      objs.wheel.position.copy(this.sm.toWorld(st.wheelCenter));
      objs.wheel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), wAxis.normalize());
      objs.rim.position.copy(objs.wheel.position);
      objs.rim.quaternion.copy(objs.wheel.quaternion);
      objs.rim.rotateX(Math.PI / 2);
    }

    // Overlays: RC markers + n-lines at each axle's X station.
    this.overlay.visible = this.showOverlays;
    if (this.showOverlays) {
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
