// SDM Kinematics — entry point. Owns the app state (car setup + pose) and
// wires panel ⇄ solver ⇄ 3D view, mirroring COAST's main-module layout.

import { SceneManager } from "./scene/SceneManager";
import { SuspensionView } from "./scene/SuspensionView";
import { Panel } from "./ui/panel";
import { drawPlot, type PlotSeries } from "./ui/plot";
import {
  defaultCar, STATIC_POSE, type AxleGeometry, type CarSetup, type Pose,
} from "./core/model";
import { solveCar, runSweep, channelDefs, type SweepResult, type SweepType } from "./core/sweep";
import { serializeProject, parseProject, sweepToCsv, download } from "./core/io";

const viewport = document.getElementById("viewport")!;
const sidebarEl = document.getElementById("sidebar")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const sweepOverlay = document.getElementById("sweep-overlay")!;

let car: CarSetup = defaultCar();
let pose: Pose = { ...STATIC_POSE };
let lastSweep: SweepResult | null = null;
let animating = false;
let animT = 0;

const sm = new SceneManager(viewport);
const view = new SuspensionView(sm, car);

function refresh(): void {
  const state = solveCar(car, pose);
  view.update(state);
  panel.showState(state);
}

const panel = new Panel(sidebarEl, {
  onPoseChange(p) {
    pose = p;
    refresh();
  },
  onHardpointChange(axle: "front" | "rear", key: keyof AxleGeometry, v) {
    (car[axle][key] as [number, number, number]) = v;
    view.setCar(car);
    refresh();
  },
  onParamChange(patch) {
    car.params = { ...car.params, ...patch };
    view.setCar(car);
    refresh();
  },
  onNameChange(name) {
    car.name = name;
  },
  onRunSweep(type: SweepType, range: number, steps: number) {
    lastSweep = runSweep(car, { type, range, steps });
    renderSweep(lastSweep);
  },
  onSave() {
    download(`${car.name.replace(/\s+/g, "-")}.kin.json`, serializeProject(car), "application/json");
  },
  onLoadClick() {
    fileInput.click();
  },
  onReset() {
    car = defaultCar();
    panel.build(car);
    panel.setPose(pose);
    view.setCar(car);
    refresh();
  },
  onOverlayToggle(on) {
    view.showOverlays = on;
    refresh();
  },
  onAnimateToggle(on) {
    animating = on;
  },
});

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    car = parseProject(await f.text());
    panel.build(car);
    panel.setPose(pose);
    view.setCar(car);
    refresh();
  } catch (e) {
    alert(`Could not load project: ${(e as Error).message}`);
  }
  fileInput.value = "";
};

// ---- Sweep overlay ----
function renderSweep(res: SweepResult): void {
  sweepOverlay.style.display = "block";
  sweepOverlay.innerHTML = "";

  const head = document.createElement("div");
  head.className = "sweep-head";
  const title = document.createElement("div");
  title.innerHTML = `<b>${res.paramLabel} sweep</b> <span class="small">±${res.spec.range} ${res.paramUnit} · ${res.values.length} steps</span>`;
  const btns = document.createElement("div");
  btns.className = "row";
  const csvBtn = document.createElement("button");
  csvBtn.textContent = "Export CSV";
  csvBtn.onclick = () => download(`sweep-${res.spec.type}.csv`, sweepToCsv(res), "text/csv");
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.onclick = () => (sweepOverlay.style.display = "none");
  btns.append(csvBtn, closeBtn);
  head.append(title, btns);
  sweepOverlay.appendChild(head);

  // Channel picker: group per-corner channels by base label so L/R share a plot.
  const defs = channelDefs();
  const groups = new Map<string, { label: string; unit: string; members: { key: string; label: string }[]; on: boolean }>();
  for (const d of defs) {
    const m = d.label.match(/^(.*) (FL|FR|RL|RR)$/);
    const base = m ? m[1] : d.label;
    const g = groups.get(base) ?? { label: base, unit: d.unit, members: [], on: false };
    g.members.push({ key: d.key, label: m ? m[2] : d.label });
    g.on = g.on || !!d.defaultOn;
    groups.set(base, g);
  }

  const picker = document.createElement("div");
  picker.className = "chk-row";
  picker.style.marginBottom = "8px";
  const grid = document.createElement("div");
  grid.className = "plot-grid";

  const redraw = () => {
    grid.innerHTML = "";
    for (const g of groups.values()) {
      if (!g.on) continue;
      const cell = document.createElement("div");
      cell.className = "plot-cell";
      const canvas = document.createElement("canvas");
      cell.appendChild(canvas);
      grid.appendChild(cell);
      const series: PlotSeries[] = g.members
        .map((mm) => ({ label: mm.label, data: res.series.get(mm.key)! }))
        .filter((s) => s.data.some((v) => Number.isFinite(v)));
      // Defer until the canvas has layout width.
      requestAnimationFrame(() =>
        drawPlot(canvas, g.label, g.unit, res.values, `${res.paramLabel} (${res.paramUnit})`, series),
      );
    }
  };

  for (const g of groups.values()) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = g.on;
    cb.onchange = () => {
      g.on = cb.checked;
      redraw();
    };
    lab.append(cb, document.createTextNode(g.label));
    picker.appendChild(lab);
  }

  sweepOverlay.append(picker, grid);
  redraw();
}

// ---- Heave animation (sinusoidal, ±1 in) ----
function tick(): void {
  requestAnimationFrame(tick);
  if (!animating) return;
  animT += 0.02;
  pose = { ...pose, heave: Math.sin(animT) * 1.0 };
  panel.setPose(pose);
  refresh();
}

panel.build(car);
refresh();
tick();
