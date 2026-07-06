// Animated force vectors: one arrow per link (blue = tension, red =
// compression, length ∝ |force|) drawn at the member midpoint along its
// axis, plus one tire-force arrow per contact patch (amber). Arrow pool is
// allocated once and repositioned per frame.

import * as THREE from "three";
import type { SceneManager } from "./SceneManager";
import type { V3 } from "../core/vec";
import { add, scale, sub, unit } from "../core/vec";
import { mirrorAxle, type CarSetup, type CornerId, CORNERS } from "../core/model";
import type { FullState } from "../core/sweep";
import { LINK_NAMES, type CornerForces, type LinkName } from "../core/forces";

const TENSION = 0x4ea1ff;
const COMPRESSION = 0xff6b6b;
const TIRE = 0xffb454;

export class ForceArrows {
  private group = new THREE.Group();
  private linkArrows = new Map<string, THREE.ArrowHelper>();
  private tireArrows = new Map<CornerId, THREE.ArrowHelper>();

  constructor(private sm: SceneManager) {
    sm.scene.add(this.group);
    for (const id of CORNERS) {
      for (const l of LINK_NAMES) {
        const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, TENSION, 1.2, 0.6);
        a.visible = false;
        this.linkArrows.set(`${id}|${l}`, a);
        this.group.add(a);
      }
      const t = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, TIRE, 1.6, 0.8);
      t.visible = false;
      this.tireArrows.set(id, t);
      this.group.add(t);
    }
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  clear(): void {
    for (const a of this.linkArrows.values()) a.visible = false;
    for (const a of this.tireArrows.values()) a.visible = false;
  }

  /** Update arrows from a solved state + that sample's forces.
   *  `scale` = inches of arrow per lbf. */
  update(car: CarSetup, state: FullState, forces: Record<CornerId, CornerForces>, inPerLb: number): void {
    for (const id of CORNERS) {
      const st = state.corners[id];
      const geoL = id[0] === "F" ? car.front : car.rear;
      const geo = id[1] === "L" ? geoL : mirrorAxle(geoL);
      const ends: Record<LinkName, [V3, V3]> = {
        LCAF: [st.p1, geo.lcaFront],
        LCAA: [st.p1, geo.lcaRear],
        UCAF: [st.p2, geo.ucaFront],
        UCAA: [st.p2, geo.ucaRear],
        TOE: [st.p3, st.tieInner],
        PR: [st.pushLower, st.pushUpper],
      };
      const f = forces[id];
      for (const l of LINK_NAMES) {
        const arrow = this.linkArrows.get(`${id}|${l}`)!;
        const v = f.links[l];
        if (!Number.isFinite(v) || Math.abs(v) < 1) { arrow.visible = false; continue; }
        const [a, b] = ends[l];
        const mid = scale(add(a, b), 0.5);
        const dir = unit(sub(b, a));
        const len = Math.min(14, Math.max(0.8, Math.abs(v) * inPerLb));
        arrow.position.copy(this.sm.toWorld(mid));
        const wDir = this.sm.toWorld(dir).sub(this.sm.toWorld([0, 0, 0])).normalize();
        arrow.setDirection(v >= 0 ? wDir : wDir.clone().negate());
        arrow.setLength(len, Math.min(1.4, len * 0.3), Math.min(0.7, len * 0.15));
        arrow.setColor(v >= 0 ? TENSION : COMPRESSION);
        arrow.visible = true;
      }
      // Tire force at the contact patch.
      const tf = f.tire;
      const mag = Math.hypot(tf[0], tf[1], tf[2]);
      const tArrow = this.tireArrows.get(id)!;
      if (mag < 1) { tArrow.visible = false; continue; }
      const cp = state.cornerCh[id].contactPatch;
      const dir = unit(tf);
      const len = Math.min(18, Math.max(1, mag * inPerLb));
      tArrow.position.copy(this.sm.toWorld(cp));
      tArrow.setDirection(this.sm.toWorld(dir).sub(this.sm.toWorld([0, 0, 0])).normalize());
      tArrow.setLength(len, Math.min(2, len * 0.25), Math.min(1, len * 0.12));
      tArrow.visible = true;
    }
  }
}
