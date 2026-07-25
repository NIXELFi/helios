// Sidebar panel — vanilla DOM in the COAST card style. The panel owns the
// widgets and calls back into main.ts; it never touches the solver directly.

import {
  HARDPOINT_KEYS, LINK_OD_KEYS, PUSHROD_HOSTS, UBAR_HOSTS, fmtCoord, relevantHardpoints,
  type AxleGeometry, type CarSetup, type LinkOD, type Pose, type SuspensionConfig,
} from "../core/model";
import type { StudyConfig, StudyResult } from "../core/clearance";
import { poseLabel } from "../core/clearance";
import type { MassProps } from "../core/forces";
import type { FullState } from "../core/sweep";
import type { SweepType } from "../core/sweep";
import { MEMBER_COLORS } from "../scene/SuspensionView";

export interface PanelCallbacks {
  onPoseChange(pose: Pose): void;
  onHardpointChange(axle: "front" | "rear", key: keyof AxleGeometry, v: [number, number, number]): void;
  onAttachmentChange(axle: "front" | "rear", kind: "pushrod" | "ubar", host: string): void;
  onParamChange(patch: Partial<CarSetup["params"]>): void;
  onNameChange(name: string): void;
  onRunSweep(type: SweepType, range: number, steps: number): void;
  onSave(): void;
  onLoadClick(): void;
  onReset(): void;
  onOverlayToggle(on: boolean): void;
  onAnimateToggle(on: boolean): void;
  /** Import OptimumK points (.xlsx or OpK-layout .json). */
  onImportPointsClick(): void;
  onExportSdmXlsx(): void;
  onExportOpkJson(): void;
  onOpenOptimizer(): void;
  onLinkOdChange(axle: "front" | "rear", key: keyof LinkOD, v: number): void;
  onRunClearance(cfg: StudyConfig): void;
  onGotoPose(pose: Pose): void;
  onMassPropsChange(patch: Partial<MassProps>): void;
  onLoadForceCsvClick(): void;
  onRunForces(cfg: ForceRunConfig): void;
  onConfigChange(axle: "front" | "rear", patch: Partial<SuspensionConfig>): void;
}

export interface ForceRunConfig {
  source: "gg" | "csv";
  latG: number;
  accelG: number;
  brakeG: number;
  points: number;
  axCol: number;
  ayCol: number;
  tCol: number | null;
}

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export class Panel {
  private pose: Pose = { heave: 0, rollDeg: 0, pitchDeg: 0, rack: 0 };
  private axle: "front" | "rear" = "front";
  private pointKey: keyof AxleGeometry = "lbj";
  private car!: CarSetup;
  private liveTable!: HTMLElement;
  private axleTable!: HTMLElement;
  private coordInputs: HTMLInputElement[] = [];
  private pointSelect!: HTMLSelectElement;
  private sliders: Record<string, { input: HTMLInputElement; label: HTMLElement }> = {};
  private segFront!: HTMLButtonElement;
  private segRear!: HTMLButtonElement;

  constructor(private root: HTMLElement, private cb: PanelCallbacks) {}

  build(car: CarSetup): void {
    this.car = car;
    this.root.innerHTML = "";
    this.root.append(
      this.projectCard(),
      this.poseCard(),
      this.configCard(),
      this.hardpointCard(),
      this.attachmentsCard(),
      this.vehicleCard(),
      this.liveCard(),
      this.sweepCard(),
      this.forcesCard(),
      this.clearanceCard(),
      this.optimizerCard(),
      this.legendCard(),
    );
    this.refreshCoordInputs();
  }

  private card(title: string): HTMLElement {
    const c = document.createElement("div");
    c.className = "card";
    const h = document.createElement("h2");
    h.textContent = title;
    c.appendChild(h);
    return c;
  }

  private btn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.onclick = onClick;
    return b;
  }

  // ---- Project ----
  private projectCard(): HTMLElement {
    const c = this.card("Project");
    const f = document.createElement("div");
    f.className = "field";
    const lab = document.createElement("span");
    lab.textContent = "Setup name";
    lab.className = "small";
    const name = document.createElement("input");
    name.value = this.car.name;
    name.onchange = () => this.cb.onNameChange(name.value);
    f.append(lab, name);
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      this.btn("Save project", () => this.cb.onSave()),
      this.btn("Load project", () => this.cb.onLoadClick()),
      this.btn("Reset", () => this.cb.onReset()),
    );
    const io = document.createElement("div");
    io.className = "row";
    io.style.marginTop = "8px";
    io.append(
      this.btn("Import points (OpK xlsx / json)", () => this.cb.onImportPointsClick()),
      this.btn("Export SDM xlsx", () => this.cb.onExportSdmXlsx()),
      this.btn("Export OpK JSON", () => this.cb.onExportOpkJson()),
    );
    c.append(f, row, io);
    return c;
  }

  private optimizerCard(): HTMLElement {
    const c = this.card("Optimizer");
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginBottom = "8px";
    note.textContent = "Multi-parameter targets with weights; box or actuation-plane mutation bounds per point.";
    const b = this.btn("Open optimizer", () => this.cb.onOpenOptimizer(), true);
    c.append(note, b);
    return c;
  }

  // ---- Pose ----
  private slider(
    key: keyof Pose, label: string, min: number, max: number, step: number, unit: string,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "slider-field";
    const lab = document.createElement("div");
    lab.className = "lab";
    const l = document.createElement("span");
    l.textContent = label;
    const val = document.createElement("b");
    val.textContent = `0.00 ${unit}`;
    lab.append(l, val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = "0";
    input.oninput = () => {
      (this.pose[key] as number) = Number(input.value);
      val.textContent = `${Number(input.value).toFixed(2)} ${unit}`;
      this.cb.onPoseChange({ ...this.pose });
    };
    this.sliders[key] = { input, label: val };
    wrap.append(lab, input);
    return wrap;
  }

  setPose(pose: Pose): void {
    this.pose = { ...pose };
    const units: Record<string, string> = { heave: "in", rollDeg: "deg", pitchDeg: "deg", rack: "in" };
    for (const k of Object.keys(this.sliders) as (keyof Pose)[]) {
      this.sliders[k].input.value = String(pose[k]);
      this.sliders[k].label.textContent = `${Number(pose[k]).toFixed(2)} ${units[k]}`;
    }
  }

  private poseCard(): HTMLElement {
    const c = this.card("Pose — live motion");
    c.append(
      this.slider("heave", "Heave (+ = compression)", -1.5, 1.5, 0.01, "in"),
      this.slider("rollDeg", "Roll (+ = right down)", -3, 3, 0.02, "deg"),
      this.slider("pitchDeg", "Pitch (+ = nose down)", -2, 2, 0.02, "deg"),
      this.slider("rack", "Rack travel (+ = left turn)", -1.4, 1.4, 0.01, "in"),
    );
    const row = document.createElement("div");
    row.className = "row";
    row.append(this.btn("Zero pose", () => {
      this.setPose({ heave: 0, rollDeg: 0, pitchDeg: 0, rack: 0 });
      this.cb.onPoseChange({ ...this.pose });
    }));
    const animate = document.createElement("label");
    animate.className = "toggle";
    const acb = document.createElement("input");
    acb.type = "checkbox";
    animate.append(acb, document.createTextNode("Animate heave"));
    acb.onchange = () => this.cb.onAnimateToggle(acb.checked);
    const overlays = document.createElement("label");
    overlays.className = "toggle";
    const ocb = document.createElement("input");
    ocb.type = "checkbox";
    ocb.checked = true;
    overlays.append(ocb, document.createTextNode("RC / IC overlays"));
    ocb.onchange = () => this.cb.onOverlayToggle(ocb.checked);
    c.append(row, animate, overlays);
    return c;
  }

  // ---- Suspension configuration ----
  private configCard(): HTMLElement {
    const c = this.card("Suspension configuration");
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginBottom = "6px";
    note.textContent = "Per-axle architecture — front and rear are independent. The hardpoint list and 3D view follow the selection.";
    c.appendChild(note);
    const opts: Record<keyof SuspensionConfig, [string, string][]> = {
      type: [["double-wishbone", "Double wishbone"], ["macpherson", "MacPherson strut"], ["multilink5", "Multi-link (5)"]],
      actuation: [["pushrod-rocker", "Pushrod + rocker"], ["pullrod-rocker", "Pullrod + rocker"], ["direct-coilover", "Direct coilover"], ["rocker-arm", "Rocker-arm (UCA)"]],
      spring: [["coil", "Coil spring"], ["torsion", "Torsion bar"]],
      decoupling: [["none", "Corner springs"], ["third-element", "3rd element + corners"], ["heave-roll", "Heave-roll decoupled"]],
      arb: [["none", "No ARB"], ["ubar", "U-bar"], ["zbar", "Z-bar"]],
    };
    const labels: Record<keyof SuspensionConfig, string> = {
      type: "Type", actuation: "Actuation", spring: "Spring", decoupling: "Decoupling", arb: "ARB",
    };
    for (const axle of ["front", "rear"] as const) {
      const h = document.createElement("div");
      h.className = "small";
      h.style.cssText = "font-weight:600;color:var(--text);margin:8px 0 4px;text-transform:uppercase;letter-spacing:1px;font-size:10px";
      h.textContent = axle === "front" ? "Front axle" : "Rear axle";
      c.appendChild(h);
      const cfg = this.car[axle].config;
      for (const key of Object.keys(opts) as (keyof SuspensionConfig)[]) {
        const f = document.createElement("div");
        f.className = "field";
        const lab = document.createElement("span");
        lab.className = "small";
        lab.textContent = labels[key];
        const sel = document.createElement("select");
        for (const [v, l] of opts[key]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = l;
          sel.appendChild(o);
        }
        sel.value = cfg[key];
        sel.onchange = () => this.cb.onConfigChange(axle, { [key]: sel.value } as Partial<SuspensionConfig>);
        f.append(lab, sel);
        c.appendChild(f);
      }
    }
    return c;
  }

  // ---- Hardpoints ----
  private hardpointCard(): HTMLElement {
    const c = this.card("Hardpoints (left side, mirrored)");
    const seg = document.createElement("div");
    seg.className = "seg";
    this.segFront = this.btn("Front", () => this.setAxle("front"));
    this.segRear = this.btn("Rear", () => this.setAxle("rear"));
    this.segFront.classList.add("seg-btn", "active");
    this.segRear.classList.add("seg-btn");
    seg.append(this.segFront, this.segRear);

    this.pointSelect = document.createElement("select");
    this.pointSelect.style.width = "100%";
    this.pointSelect.style.margin = "8px 0";
    this.pointSelect.style.background = "var(--bg)";
    this.pointSelect.style.color = "var(--text)";
    this.pointSelect.style.border = "1px solid var(--line)";
    this.pointSelect.style.borderRadius = "6px";
    this.pointSelect.style.padding = "5px 7px";
    this.repopulatePointSelect();
    this.pointSelect.onchange = () => {
      this.pointKey = this.pointSelect.value as keyof AxleGeometry;
      this.refreshCoordInputs();
    };

    const coords = document.createElement("div");
    coords.className = "coord-row";
    this.coordInputs = [];
    (["X (fwd)", "Y (left)", "Z (up)"] as const).forEach((axis, i) => {
      const lab = document.createElement("label");
      lab.textContent = axis;
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "0.05";
      inp.onchange = () => {
        const v = this.coordInputs.map((x) => Number(x.value)) as [number, number, number];
        if (v.every(Number.isFinite)) this.cb.onHardpointChange(this.axle, this.pointKey, v);
      };
      this.coordInputs[i] = inp;
      lab.appendChild(inp);
      coords.appendChild(lab);
    });

    const note = document.createElement("div");
    note.className = "small";
    note.style.marginTop = "6px";
    note.textContent = "in · X+ fwd · Y+ left · Z+ up · origin mid-wheelbase @ ground";
    c.append(seg, this.pointSelect, coords, note);
    return c;
  }

  private setAxle(a: "front" | "rear"): void {
    this.axle = a;
    this.segFront.classList.toggle("active", a === "front");
    this.segRear.classList.toggle("active", a === "rear");
    this.repopulatePointSelect();
    this.refreshCoordInputs();
  }

  /** The editable point list follows the axle's suspension configuration. */
  private repopulatePointSelect(): void {
    const keys = relevantHardpoints(this.car[this.axle]);
    this.pointSelect.innerHTML = "";
    for (const { key, label } of HARDPOINT_KEYS) {
      if (!keys.includes(key)) continue;
      const o = document.createElement("option");
      o.value = key;
      o.textContent = label;
      this.pointSelect.appendChild(o);
    }
    if (!keys.includes(this.pointKey)) this.pointKey = keys[0];
    this.pointSelect.value = this.pointKey;
  }

  refreshCoordInputs(): void {
    const p = this.car[this.axle][this.pointKey] as [number, number, number];
    p.forEach((v, i) => (this.coordInputs[i].value = fmtCoord(v)));
  }

  /** Attachments: which linkage carries the pushrod pickup and the U-bar
   *  droplink pickup — the OpK "Attachment" section, made explicit. */
  private attachmentsCard(): HTMLElement {
    const c = this.card("Attachments (pickup hosts)");
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginBottom = "8px";
    note.textContent =
      "The host body decides how the solver carries the pickup through travel. " +
      "Pushrod = NSMA_PPAttPnt · U-bar = NSMA_UBarAttPnt.";
    c.appendChild(note);
    for (const axle of ["front", "rear"] as const) {
      const mk = (
        label: string,
        hosts: { value: string; label: string }[],
        current: string,
        kind: "pushrod" | "ubar",
      ) => {
        const f = document.createElement("div");
        f.className = "field";
        const lab = document.createElement("span");
        lab.className = "small";
        lab.textContent = label;
        const sel = document.createElement("select");
        for (const h of hosts) {
          const o = document.createElement("option");
          o.value = h.value;
          o.textContent = h.label;
          sel.appendChild(o);
        }
        sel.value = current;
        sel.onchange = () => this.cb.onAttachmentChange(axle, kind, sel.value);
        f.append(lab, sel);
        return f;
      };
      const g = this.car[axle];
      const ax = axle === "front" ? "Front" : "Rear";
      c.append(
        mk(`${ax} pushrod on`, PUSHROD_HOSTS, g.pushrodOn, "pushrod"),
        mk(`${ax} U-bar pickup on`, UBAR_HOSTS, g.ubarOn, "ubar"),
      );
    }
    return c;
  }

  setCar(car: CarSetup): void {
    this.car = car;
    this.refreshCoordInputs();
  }

  // ---- Vehicle params ----
  private numField(label: string, value: number, onChange: (v: number) => void): HTMLElement {
    const f = document.createElement("div");
    f.className = "field";
    const lab = document.createElement("span");
    lab.className = "small";
    lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.value = String(value);
    // Commit on every keystroke, not just blur — otherwise a retyped value
    // sits in the box while the channels still show the old one, which reads
    // as "changing this does nothing". An empty box is mid-edit, not a zero.
    const commit = () => {
      if (inp.value.trim() === "") return;
      const v = Number(inp.value);
      if (Number.isFinite(v)) onChange(v);
    };
    inp.oninput = commit;
    inp.onchange = commit;
    f.append(lab, inp);
    return f;
  }

  private vehicleCard(): HTMLElement {
    const c = this.card("Vehicle");
    const p = this.car.params;
    c.append(
      this.numField("Tire radius (in)", p.tireRadius, (v) => this.cb.onParamChange({ tireRadius: v })),
      this.numField("Tire width (in)", p.tireWidth, (v) => this.cb.onParamChange({ tireWidth: v })),
      this.numField("Spring rate F (lb/in)", p.springRateFront, (v) => this.cb.onParamChange({ springRateFront: v })),
      this.numField("Spring rate R (lb/in)", p.springRateRear, (v) => this.cb.onParamChange({ springRateRear: v })),
      this.numField("CG height (in)", p.cgHeight, (v) => this.cb.onParamChange({ cgHeight: v })),
      this.numField("Brake bias front (0–1)", p.brakeBiasFront, (v) => this.cb.onParamChange({ brakeBiasFront: v })),
      this.numField("Coilover min F (in)", p.coilMinFront, (v) => this.cb.onParamChange({ coilMinFront: v })),
      this.numField("Coilover max F (in)", p.coilMaxFront, (v) => this.cb.onParamChange({ coilMaxFront: v })),
      this.numField("Coilover min R (in)", p.coilMinRear, (v) => this.cb.onParamChange({ coilMinRear: v })),
      this.numField("Coilover max R (in)", p.coilMaxRear, (v) => this.cb.onParamChange({ coilMaxRear: v })),
      this.numField("Torsion rate F (lb·in/deg)", p.torsionRateFront, (v) => this.cb.onParamChange({ torsionRateFront: v })),
      this.numField("Torsion rate R (lb·in/deg)", p.torsionRateRear, (v) => this.cb.onParamChange({ torsionRateRear: v })),
      this.numField("3rd element rate F (lb/in)", p.thirdRateFront, (v) => this.cb.onParamChange({ thirdRateFront: v })),
      this.numField("3rd element rate R (lb/in)", p.thirdRateRear, (v) => this.cb.onParamChange({ thirdRateRear: v })),
      this.numField("Roll element rate F (lb/in)", p.rollRateFront, (v) => this.cb.onParamChange({ rollRateFront: v })),
      this.numField("Roll element rate R (lb/in)", p.rollRateRear, (v) => this.cb.onParamChange({ rollRateRear: v })),
    );
    return c;
  }

  /** Dynamic force calculator: mass properties + input source + run. */
  private forcesCard(): HTMLElement {
    const c = this.card("Dynamic forces");
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginBottom = "6px";
    note.textContent =
      "SDM27 load-transfer model with live RC/pitch-center heights; 6-link axial solve per corner at the loaded pose. " +
      "Input a G-G envelope phasor sweep or a CSV acceleration trace (G units).";
    c.appendChild(note);

    const mp = this.massProps;
    const mpField = (label: string, key: keyof MassProps, step = 1) =>
      this.numFieldCb(label, mp[key], step, (v) => this.cb.onMassPropsChange({ [key]: v }));
    c.append(
      mpField("Sprung weight (lb)", "sprungWeight"),
      mpField("Front weight dist (0–1)", "frontWeightDist", 0.01),
      mpField("Unsprung F (lb/axle)", "unsprungWeightFront"),
      mpField("Unsprung R (lb/axle)", "unsprungWeightRear"),
      mpField("Unsprung CG h (in)", "unsprungCgHeight", 0.1),
      mpField("Roll stiff dist F (0–1)", "rsd", 0.01),
    );

    const seg = document.createElement("div");
    seg.className = "seg";
    seg.style.margin = "8px 0";
    const bGG = this.btn("G-G envelope", () => setSource("gg"));
    const bCSV = this.btn("CSV trace", () => setSource("csv"));
    bGG.classList.add("seg-btn", "active");
    bCSV.classList.add("seg-btn");
    seg.append(bGG, bCSV);
    c.appendChild(seg);

    const ggBox = document.createElement("div");
    const latF = this.numFieldRaw("Lat G ±", "2.2");
    const accF = this.numFieldRaw("Accel G", "1.1");
    const brkF = this.numFieldRaw("Brake G", "1.7");
    const ptsF = this.numFieldRaw("Points", "72");
    ggBox.append(latF, accF, brkF, ptsF);
    c.appendChild(ggBox);

    const csvBox = document.createElement("div");
    csvBox.style.display = "none";
    const loadBtn = this.btn("Load CSV…", () => this.cb.onLoadForceCsvClick());
    loadBtn.style.marginBottom = "6px";
    csvBox.appendChild(loadBtn);
    const colWrap = document.createElement("div");
    csvBox.appendChild(colWrap);
    c.appendChild(csvBox);

    let source: "gg" | "csv" = "gg";
    const setSource = (s: "gg" | "csv") => {
      source = s;
      bGG.classList.toggle("active", s === "gg");
      bCSV.classList.toggle("active", s === "csv");
      ggBox.style.display = s === "gg" ? "" : "none";
      csvBox.style.display = s === "csv" ? "" : "none";
    };

    this.csvColSelects = null;
    this.setForceCsvColumns = (headers: string[]) => {
      colWrap.innerHTML = "";
      const mkSel = (label: string, withNone: boolean, guess: RegExp): HTMLSelectElement => {
        const f = document.createElement("div");
        f.className = "field";
        const lab = document.createElement("span");
        lab.className = "small";
        lab.textContent = label;
        const sel = document.createElement("select");
        if (withNone) {
          const o = document.createElement("option");
          o.value = "-1";
          o.textContent = "(index)";
          sel.appendChild(o);
        }
        headers.forEach((h, i) => {
          const o = document.createElement("option");
          o.value = String(i);
          o.textContent = h;
          sel.appendChild(o);
        });
        const hit = headers.findIndex((h) => guess.test(h));
        if (hit >= 0) sel.value = String(hit);
        f.append(lab, sel);
        colWrap.appendChild(f);
        return sel;
      };
      this.csvColSelects = {
        ax: mkSel("Ax column (long G)", false, /long|ax\b|a_x|accel.*x/i),
        ay: mkSel("Ay column (lat G)", false, /lat|ay\b|a_y|accel.*y/i),
        t: mkSel("Time column", true, /time|^t$|sec/i),
      };
      setSource("csv");
    };

    const val = (f: HTMLElement) => Number((f.querySelector("input") as HTMLInputElement).value) || 0;
    const run = this.btn("Run forces", () => {
      this.cb.onRunForces({
        source,
        latG: Math.abs(val(latF)),
        accelG: Math.abs(val(accF)),
        brakeG: Math.abs(val(brkF)),
        points: Math.max(8, Math.round(val(ptsF))),
        axCol: this.csvColSelects ? Number(this.csvColSelects.ax.value) : 0,
        ayCol: this.csvColSelects ? Number(this.csvColSelects.ay.value) : 1,
        tCol: this.csvColSelects && Number(this.csvColSelects.t.value) >= 0
          ? Number(this.csvColSelects.t.value) : null,
      });
    }, true);
    run.style.marginTop = "6px";
    c.appendChild(run);
    return c;
  }

  private massProps!: MassProps;
  private csvColSelects: { ax: HTMLSelectElement; ay: HTMLSelectElement; t: HTMLSelectElement } | null = null;
  /** Populated by forcesCard; called by main after a CSV is parsed. */
  setForceCsvColumns: (headers: string[]) => void = () => {};

  setMassProps(mp: MassProps): void {
    this.massProps = mp;
  }

  private numFieldCb(label: string, value: number, step: number, onChange: (v: number) => void): HTMLElement {
    const f = document.createElement("div");
    f.className = "field";
    const lab = document.createElement("span");
    lab.className = "small";
    lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = String(step);
    inp.value = String(value);
    const commit = () => {
      if (inp.value.trim() === "") return; // mid-edit, not a zero
      const v = Number(inp.value);
      if (Number.isFinite(v)) onChange(v);
    };
    inp.oninput = commit;
    inp.onchange = commit;
    f.append(lab, inp);
    return f;
  }

  /** Link ODs + motion-study ranges + run. Results render in the overlay. */
  private clearanceCard(): HTMLElement {
    const c = this.card("Clearance / motion study");
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginBottom = "6px";
    note.textContent =
      "Links are capsules at their OD (A-arm fore/aft legs share the arm OD); the tire is a cylinder. " +
      "The study visits every extreme combination of heave × roll × pitch × steer.";
    c.appendChild(note);

    // OD table: rows per link, F and R columns.
    const tbl = document.createElement("table");
    tbl.className = "chan";
    let html = `<tr><th>Link OD in</th><th>Front</th><th>Rear</th></tr>`;
    tbl.innerHTML = html;
    for (const { key, label } of LINK_OD_KEYS) {
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      td0.textContent = label;
      tr.appendChild(td0);
      for (const axle of ["front", "rear"] as const) {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "0.0625";
        inp.value = String(this.car[axle].linkOD[key]);
        inp.style.cssText = "width:56px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:5px;padding:2px 4px;font-size:11px;text-align:right";
        inp.onchange = () => {
          const v = Number(inp.value);
          if (Number.isFinite(v) && v > 0) this.cb.onLinkOdChange(axle, key, v);
        };
        td.appendChild(inp);
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    c.appendChild(tbl);

    const mkRange = (label: string, value: string): HTMLElement => {
      const f = this.numFieldRaw(label, value);
      f.style.marginTop = "6px";
      return f;
    };
    const heaveF = mkRange("Heave ± in", "1.2");
    const rollF = mkRange("Roll ± deg", "2.5");
    const pitchF = mkRange("Pitch ± deg", "1.5");
    const rackF = mkRange("Rack ± in", "1.3");
    const stepsF = mkRange("Steps / axis", "3");
    c.append(heaveF, rollF, pitchF, rackF, stepsF);

    const val = (f: HTMLElement) => Math.abs(Number((f.querySelector("input") as HTMLInputElement).value) || 0);
    const run = this.btn("Run motion study", () => {
      this.cb.onRunClearance({
        heaveRange: val(heaveF),
        rollRange: val(rollF),
        pitchRange: val(pitchF),
        rackRange: val(rackF),
        steps: Math.max(2, Math.round(val(stepsF))),
      });
    }, true);
    run.style.marginTop = "8px";
    c.appendChild(run);

    const barWrap = document.createElement("div");
    barWrap.style.cssText = "background:var(--bg);border:1px solid var(--line);border-radius:6px;height:8px;margin-top:8px;overflow:hidden";
    this.clearBar = document.createElement("div");
    this.clearBar.style.cssText = "height:100%;width:0%;background:var(--accent);transition:width 0.15s";
    barWrap.appendChild(this.clearBar);
    this.clearSummary = document.createElement("div");
    this.clearSummary.className = "small";
    this.clearSummary.style.marginTop = "6px";
    c.append(barWrap, this.clearSummary);
    return c;
  }

  private clearBar!: HTMLElement;
  private clearSummary!: HTMLElement;

  showClearanceProgress(done: number, total: number): void {
    this.clearBar.style.width = `${Math.round((100 * done) / Math.max(1, total))}%`;
    this.clearSummary.textContent = `checking pose ${done}/${total}…`;
  }

  showClearanceSummary(res: StudyResult): void {
    if (!res.min) {
      this.clearSummary.textContent = "No trackable pairs (everything adjacent?).";
      return;
    }
    const m = res.min;
    const cls = m.clearance < 0 ? "val-bad" : m.clearance < 0.1 ? "val-warn" : "val-good";
    this.clearSummary.innerHTML =
      `Min clearance <b class="${cls}">${m.clearance.toFixed(3)}"</b> — ` +
      `${m.corner} ${m.aName} ↔ ${m.bName} @ ${poseLabel(m.pose)}` +
      (res.bottoming.length ? ` · <span class="val-warn">${res.bottoming.length} pose(s) hit coilover stops</span>` : "") +
      ` · full table in overlay`;
  }

  // ---- Live outputs ----
  private liveCard(): HTMLElement {
    const c = this.card("Live channels");
    this.liveTable = document.createElement("div");
    this.axleTable = document.createElement("div");
    this.axleTable.style.marginTop = "8px";
    c.append(this.liveTable, this.axleTable);
    return c;
  }

  showState(s: FullState): void {
    const ids = ["FL", "FR", "RL", "RR"] as const;
    const rows: [string, (id: (typeof ids)[number]) => string][] = [
      ["Camber °", (id) => fmt(s.cornerCh[id].camber)],
      ["Toe °", (id) => fmt(s.cornerCh[id].toe)],
      ["Caster °", (id) => fmt(s.cornerCh[id].caster)],
      ["KPI °", (id) => fmt(s.cornerCh[id].kpi)],
      ["Trail in", (id) => fmt(s.cornerCh[id].mechTrail)],
      ["Scrub in", (id) => fmt(s.cornerCh[id].scrub)],
      ["IR —", (id) => fmt(s.cornerCh[id].installRatio, 3)],
      ["WR lb/in", (id) => fmt(s.cornerCh[id].wheelRate, 1)],
      ["Lat scrub in", (id) => fmt(s.cornerCh[id].lateralScrub, 3)],
      ["Shock in", (id) => {
        const c = s.cornerCh[id];
        const isF = id[0] === "F";
        const lo = isF ? this.car.params.coilMinFront : this.car.params.coilMinRear;
        const hi = isF ? this.car.params.coilMaxFront : this.car.params.coilMaxRear;
        const bad = c.shockLength < lo || c.shockLength > hi;
        return bad ? `<span class="val-bad">${fmt(c.shockLength)}</span>` : fmt(c.shockLength);
      }],
      ["Trvl b/d in", (id) => `${fmt(s.cornerCh[id].travelBump, 2)}/${fmt(s.cornerCh[id].travelDroop, 2)}`],
      ["Total trvl in", (id) => fmt(s.cornerCh[id].travelTotal, 2)],
    ];
    let html = `<table class="chan"><tr><th></th>${ids.map((i) => `<th>${i}</th>`).join("")}</tr>`;
    for (const [lab, f] of rows) {
      html += `<tr><td>${lab}</td>${ids.map((id) => `<td>${f(id)}</td>`).join("")}</tr>`;
    }
    html += "</table>";
    const solveOk = ids.every((id) => s.corners[id].ok);
    if (!solveOk) html += `<div class="small val-bad" style="margin-top:4px">⚠ solver did not converge at this pose</div>`;
    this.liveTable.innerHTML = html;

    const f = s.frontAxle, r = s.rearAxle;
    this.axleTable.innerHTML = `
      <table class="chan">
        <tr><th></th><th>Front</th><th>Rear</th></tr>
        <tr><td>RC height in</td><td>${fmt(f.rollCenter[1])}</td><td>${fmt(r.rollCenter[1])}</td></tr>
        <tr><td>RC lateral in</td><td>${fmt(f.rollCenter[0])}</td><td>${fmt(r.rollCenter[0])}</td></tr>
        <tr><td>Anti-dive F / lift R (brk)</td><td>${fmt(f.antiBrakePct, 1)}</td><td>${fmt(r.antiBrakePct, 1)}</td></tr>
        <tr><td>Anti-lift F / squat R (acc)</td><td>${fmt(f.antiAccelPct, 1)}</td><td>${fmt(r.antiAccelPct, 1)}</td></tr>
        <tr><td>Total anti-pitch brk / acc</td><td>${fmt(s.antiPitchBraking, 1)}</td><td>${fmt(s.antiPitchAccel, 1)}</td></tr>
        <tr><td>Bump steer L °/in</td><td>${fmt(f.bumpSteerLeft, 3)}</td><td>${fmt(r.bumpSteerLeft, 3)}</td></tr>
        <tr><td>Camber gain L °/in</td><td>${fmt(f.camberGainLeft, 3)}</td><td>${fmt(r.camberGainLeft, 3)}</td></tr>
        <tr><td>ARB twist °</td><td>${fmt(s.ubarTwistFront, 3)}</td><td>${fmt(s.ubarTwistRear, 3)}</td></tr>
        <tr><td>ARB twist ratio °/in</td><td>${fmt(f.arbTwistRatioLeft, 3)}</td><td>${fmt(r.arbTwistRatioLeft, 3)}</td></tr>
        <tr><td>ARB MR (whl/link)</td><td>${fmt(f.arbMotionRatioLeft, 3)}</td><td>${fmt(r.arbMotionRatioLeft, 3)}</td></tr>
        <tr><td>ARB IR (link/whl)</td><td>${fmt(f.arbInstallRatioLeft, 3)}</td><td>${fmt(r.arbInstallRatioLeft, 3)}</td></tr>
        <tr><td>WR heave lb/in</td><td>${fmt(f.wheelRateHeave, 1)}</td><td>${fmt(r.wheelRateHeave, 1)}</td></tr>
        <tr><td>WR roll lb/in</td><td>${fmt(f.wheelRateRoll, 1)}</td><td>${fmt(r.wheelRateRoll, 1)}</td></tr>
        <tr><td>Ackermann %</td><td colspan="2">${s.ackermann === null ? "— (steer to read)" : fmt(s.ackermann, 1)}</td></tr>
      </table>`;
  }

  // ---- Sweep ----
  private sweepCard(): HTMLElement {
    const c = this.card("Sweep analysis");
    const typeF = document.createElement("div");
    typeF.className = "field";
    const tl = document.createElement("span");
    tl.className = "small";
    tl.textContent = "Motion";
    const type = document.createElement("select");
    for (const [v, lab] of [["heave", "Heave (in)"], ["roll", "Roll (deg)"], ["pitch", "Pitch (deg)"], ["steer", "Steer — rack (in)"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lab;
      type.appendChild(o);
    }
    typeF.append(tl, type);

    const rangeF = this.numFieldRaw("Range ±", "1.0");
    const stepsF = this.numFieldRaw("Steps", "21");
    const run = this.btn("Run sweep", () => {
      this.cb.onRunSweep(
        type.value as SweepType,
        Math.abs(Number((rangeF.querySelector("input") as HTMLInputElement).value) || 1),
        Number((stepsF.querySelector("input") as HTMLInputElement).value) || 21,
      );
    }, true);
    type.onchange = () => {
      const inp = rangeF.querySelector("input") as HTMLInputElement;
      inp.value = type.value === "roll" ? "2.0" : type.value === "pitch" ? "1.5" : "1.0";
    };
    c.append(typeF, rangeF, stepsF, run);
    return c;
  }

  private numFieldRaw(label: string, value: string): HTMLElement {
    const f = document.createElement("div");
    f.className = "field";
    const lab = document.createElement("span");
    lab.className = "small";
    lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.value = value;
    f.append(lab, inp);
    return f;
  }

  // ---- Legend ----
  private legendCard(): HTMLElement {
    const c = this.card("Legend");
    const items: [string, number][] = [
      ["Lower A-arm", MEMBER_COLORS.lca],
      ["Upper A-arm", MEMBER_COLORS.uca],
      ["Toe link / tie rod", MEMBER_COLORS.tie],
      ["Pushrod", MEMBER_COLORS.push],
      ["Rocker", MEMBER_COLORS.rocker],
      ["Coilover", MEMBER_COLORS.shock],
      ["U/Z-bar / droplink", MEMBER_COLORS.ubar],
      ["3rd / roll element", MEMBER_COLORS.element],
      ["Upright / kingpin", MEMBER_COLORS.upright],
    ];
    for (const [lab, col] of items) {
      const d = document.createElement("div");
      d.className = "legend-item";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = `#${col.toString(16).padStart(6, "0")}`;
      d.append(sw, document.createTextNode(lab));
      c.appendChild(d);
    }
    const rc = document.createElement("div");
    rc.className = "legend-item";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = "#ff6b6b";
    rc.append(dot, document.createTextNode("Roll center (dashed = n-lines)"));
    c.appendChild(rc);
    return c;
  }
}
