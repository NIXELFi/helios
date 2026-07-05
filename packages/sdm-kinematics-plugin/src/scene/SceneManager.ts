// The 3D environment — deliberately identical to the COAST module's scene so
// the two chassis-side tools feel like one product family:
//   background 0x0E1116, PerspectiveCamera(45°, 0.1–5000) @ (60, 50, 90),
//   antialiased renderer at devicePixelRatio, damped OrbitControls (0.08),
//   AmbientLight + DirectionalLight both 0.8, GridHelper(160, 16) in the panel
//   line colours, AxesHelper(12), and the same Z-up-data → Y-up-world mapping
//   (car [x, y, z] → world [x, z, y]).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { V3 } from "../core/vec";

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene.background = new THREE.Color(0x0e1116);

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
    this.camera.position.set(60, 50, 90);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(50, 80, 60);
    this.scene.add(dir);

    this.scene.add(new THREE.GridHelper(160, 16, 0x2a313c, 0x1c2129));
    this.scene.add(new THREE.AxesHelper(12));

    window.addEventListener("resize", () => this.onResize());
    this.animate();
  }

  /** Car coordinates (X fwd, Y left, Z up) → world (three.js Y-up). */
  toWorld(p: V3): THREE.Vector3 {
    return new THREE.Vector3(p[0], p[2], p[1]);
  }

  /** Re-aim the view at a new point of interest (keeps the camera offset).
   *  Needed because OpK coordinates put the origin at the front axle, so the
   *  car body sits at negative X rather than around the grid center. */
  focusOn(target: THREE.Vector3): void {
    const delta = target.clone().sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
