// SDM Kinematics — entry point. Owns the app state (car setup + pose) and
// wires panel ⇄ solver ⇄ 3D view, mirroring COAST's main-module layout.

import { SceneManager } from "./scene/SceneManager";
import { SuspensionView } from "./scene/SuspensionView";
import { Panel } from "./ui/panel";
import { drawPlot, type PlotSeries } from "./ui/plot";
import {
  defaultCar, roundPoint, STATIC_POSE, type AxleGeometry, type CarSetup, type Pose,
} from "./core/model";
import { solveCar, runSweep, channelDefs, type SweepResult, type SweepType } from "./core/sweep";
import { serializeProject, parseProject, sweepToCsv, download } from "./core/io";
import { importOpkExcel, importOpkJson, exportSdmExcel, exportOpkJson } from "./core/opk";
import { runClearanceStudy, poseLabel, type StudyHandle, type StudyResult } from "./core/clearance";
import { runOptimizer, type OptResult, type RunHandle, type OptimizerConfig } from "./core/optimizer";
import { generateReport } from "./core/report";
import { OptimizerPanel } from "./ui/optimizerPanel";

const viewport = document.getElementById("viewport")!;
const sidebarEl = document.getElementById("sidebar")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const pointsInput = document.getElementById("points-input") as HTMLInputElement;
const sweepOverlay = document.getElementById("sweep-overlay")!;
const optOverlay = document.getElementById("opt-overlay")!;

let car: CarSetup = defaultCar();
let pose: Pose = { ...STATIC_POSE };
let lastSweep: SweepResult | null = null;
let animating = false;
let animT = 0;
let optHandle: RunHandle | null = null;
let optResult: OptResult | null = null;
let studyHandle: StudyHandle | null = null;

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
    (car[axle][key] as [number, number, number]) = roundPoint(v);
    panel.refreshCoordInputs();
    view.setCar(car);
    refresh();
  },
  onAttachmentChange(axle: "front" | "rear", kind: "pushrod" | "ubar", host: string) {
    if (kind === "pushrod") {
      car[axle].pushrodOn = host as AxleGeometry["pushrodOn"];
    } else {
      car[axle].ubarOn = host as AxleGeometry["ubarOn"];
    }
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
  onImportPointsClick() {
    pointsInput.click();
  },
  onExportSdmXlsx() {
    const buf = exportSdmExcel(car);
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${car.name.replace(/\s+/g, "-")}-SDM-points.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  },
  onExportOpkJson() {
    download(`${car.name.replace(/\s+/g, "-")}-opk-points.json`, exportOpkJson(car), "application/json");
  },
  onOpenOptimizer() {
    optPanel.open();
  },
  onLinkOdChange(axle, key, v) {
    car[axle].linkOD = { ...car[axle].linkOD, [key]: v };
  },
  onRunClearance(cfg) {
    studyHandle?.cancel();
    view.clearClearanceMarker();
    studyHandle = runClearanceStudy(car, cfg, (done, total) => panel.showClearanceProgress(done, total));
    studyHandle.done.then((res) => {
      studyHandle = null;
      panel.showClearanceSummary(res);
      renderClearanceResults(res);
      if (res.min) view.setClearanceMarker(res.min.pA, res.min.pB);
    });
  },
  onGotoPose(p) {
    pose = { ...p };
    panel.setPose(pose);
    refresh();
  },
});

function renderClearanceResults(res: StudyResult): void {
  sweepOverlay.style.display = "block";
  sweepOverlay.innerHTML = "";
  const head = document.createElement("div");
  head.className = "sweep-head";
  const title = document.createElement("div");
  title.innerHTML =
    `<b>Motion study</b> <span class="small">${res.posesChecked} poses · ` +
    `${res.pairsTracked} pairs tracked (${res.pairsExcluded} adjacent excluded)` +
    (res.solverFailures ? ` · <span class="val-warn">${res.solverFailures} unsolvable poses</span>` : "") +
    `</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.onclick = () => (sweepOverlay.style.display = "none");
  head.append(title, closeBtn);
  sweepOverlay.appendChild(head);

  const fmtP = (v: number) => v.toFixed(3);
  let html = `<table class="chan"><tr><th style="text-align:left">Pair</th><th>Corner</th><th>Min clr in</th><th style="text-align:left">Motion condition</th><th style="text-align:left">Location [x y z]</th><th></th></tr>`;
  const rows: string[] = [];
  res.worstPairs.forEach((h, i) => {
    const cls = h.clearance < 0 ? "val-bad" : h.clearance < 0.1 ? "val-warn" : "";
    rows.push(
      `<tr><td style="text-align:left">${h.aName} ↔ ${h.bName}</td><td>${h.corner}</td>` +
      `<td class="${cls}">${fmtP(h.clearance)}</td>` +
      `<td style="text-align:left">${poseLabel(h.pose)}</td>` +
      `<td style="text-align:left">${fmtP(h.location[0])}, ${fmtP(h.location[1])}, ${fmtP(h.location[2])}</td>` +
      `<td><button data-hit="${i}" style="padding:2px 8px;font-size:11px">View</button></td></tr>`,
    );
  });
  html += rows.join("") + "</table>";
  const tblWrap = document.createElement("div");
  tblWrap.innerHTML = html;
  sweepOverlay.appendChild(tblWrap);
  tblWrap.querySelectorAll("button[data-hit]").forEach((b) => {
    (b as HTMLButtonElement).onclick = () => {
      const h = res.worstPairs[Number((b as HTMLElement).dataset.hit)];
      pose = { ...h.pose };
      panel.setPose(pose);
      refresh();
      view.setClearanceMarker(h.pA, h.pB);
    };
  });

  if (res.bottoming.length) {
    const bt = document.createElement("div");
    bt.className = "small";
    bt.style.marginTop = "8px";
    const first = res.bottoming.slice(0, 6)
      .map((b) => `${b.corner} shock ${b.shockLength.toFixed(3)}" (${b.limit}) @ ${poseLabel(b.pose)}`)
      .join(" · ");
    bt.innerHTML = `<span class="val-warn">⚠ coilover stops hit at ${res.bottoming.length} pose(s):</span> ${first}${res.bottoming.length > 6 ? " …" : ""}`;
    sweepOverlay.appendChild(bt);
  } else {
    const ok = document.createElement("div");
    ok.className = "small val-good";
    ok.style.marginTop = "8px";
    ok.textContent = "✓ no coilover stop violations across the studied envelope";
    sweepOverlay.appendChild(ok);
  }
}

function adoptCar(next: CarSetup, warnings: string[]): void {
  car = next;
  panel.build(car);
  panel.setPose(pose);
  view.setCar(car);
  refresh();
  if (warnings.length) alert(`Imported with warnings:\n\n- ${warnings.join("\n- ")}`);
}

pointsInput.onchange = async () => {
  const f = pointsInput.files?.[0];
  if (!f) return;
  try {
    if (/\.xlsx$/i.test(f.name)) {
      const { car: next, warnings } = importOpkExcel(await f.arrayBuffer());
      adoptCar(next, warnings);
    } else {
      const text = await f.text();
      const obj = JSON.parse(text);
      if (obj?.tool === "sdm-kinematics") {
        adoptCar(parseProject(text), []);
      } else {
        const { car: next, warnings } = importOpkJson(text);
        adoptCar(next, warnings);
      }
    }
  } catch (e) {
    alert(`Could not import points: ${(e as Error).message}`);
  }
  pointsInput.value = "";
};

// ---- Optimizer ----
const optPanel = new OptimizerPanel(optOverlay, {
  onRun(config: OptimizerConfig) {
    try {
      optResult = null;
      optHandle = runOptimizer(car, config, (p) => optPanel.showProgress(p));
      optPanel.setRunning(true);
      optHandle.done.then((res) => {
        optResult = res;
        optHandle = null;
        optPanel.showResult(res);
      });
    } catch (e) {
      alert((e as Error).message);
    }
  },
  onCancel() {
    optHandle?.cancel();
  },
  onApply() {
    if (!optResult) return;
    // Coordinates land on the 3-decimal grid — nobody machines to 4 places.
    const rounded = { ...optResult.bestCar, front: { ...optResult.bestCar.front }, rear: { ...optResult.bestCar.rear } };
    for (const axle of ["front", "rear"] as const) {
      for (const p of optResult.config.points) {
        if (p.enabled && p.axle === axle) {
          (rounded[axle][p.key] as [number, number, number]) =
            roundPoint(rounded[axle][p.key] as [number, number, number]);
        }
      }
    }
    car = {
      ...rounded,
      name: `${optResult.seedCar.name} (optimized)`,
    };
    panel.build(car);
    panel.setPose(pose);
    view.setCar(car);
    refresh();
  },
  onRevert() {
    if (!optResult) return;
    car = optResult.seedCar;
    panel.build(car);
    panel.setPose(pose);
    view.setCar(car);
    refresh();
  },
  onReport() {
    if (!optResult) return;
    void generateReport(optResult);
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

// Dev-only debug hooks for automated verification — vite replaces
// import.meta.env.DEV with false in production, so none of this (including
// the fetch) survives into the published single-file bundle.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sdm = {
    getCar: () => car,
    solve: () => solveCar(car, pose),
    importXlsxUrl: async (url: string) => {
      const r = await fetch(url);
      const { car: next, warnings } = importOpkExcel(await r.arrayBuffer());
      adoptCar(next, warnings);
      return warnings;
    },
    importJsonText: (t: string) => {
      const { car: next, warnings } = importOpkJson(t);
      adoptCar(next, warnings);
      return warnings;
    },
    exportJson: () => exportOpkJson(car),
    exportXlsxBytes: () => exportSdmExcel(car).byteLength,
    reportB64: async () => {
      if (!optResult) return null;
      const buf = (await generateReport(optResult, { returnBytes: true })) as ArrayBuffer;
      const b = new Uint8Array(buf);
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) {
        s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      }
      return btoa(s);
    },
    runOpt: (config: OptimizerConfig) =>
      runOptimizer(car, config, () => {}).done.then(async (res) => {
        optResult = res;
        const pdf = (await generateReport(res, { returnBytes: true })) as ArrayBuffer;
        return {
          seed: res.seedObjective,
          best: res.bestObjective,
          perParam: res.perParam,
          bestFront: res.bestCar.front,
          seedFront: res.seedCar.front,
          pdfBytes: pdf.byteLength,
        };
      }),
  };
}
