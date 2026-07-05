// Sidebar panel — vanilla DOM in the COAST card style. The panel owns the
// widgets and calls back into main.ts; it never touches the solver directly.

import {
  HARDPOINT_KEYS, PUSHROD_HOSTS, UBAR_HOSTS, fmtCoord,
  type AxleGeometry, type CarSetup, type Pose,
} from "../core/model";
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
      this.hardpointCard(),
      this.attachmentsCard(),
      this.vehicleCard(),
      this.liveCard(),
      this.sweepCard(),
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
    for (const { key, label } of HARDPOINT_KEYS) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = label;
      this.pointSelect.appendChild(o);
    }
    this.pointSelect.value = this.pointKey;
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
    this.refreshCoordInputs();
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
    inp.onchange = () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) onChange(v);
    };
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
    );
    return c;
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
        <tr><td>Anti %</td><td>${fmt(f.antiPct, 1)}</td><td>${fmt(r.antiPct, 1)}</td></tr>
        <tr><td>Bump steer L °/in</td><td>${fmt(f.bumpSteerLeft, 3)}</td><td>${fmt(r.bumpSteerLeft, 3)}</td></tr>
        <tr><td>Camber gain L °/in</td><td>${fmt(f.camberGainLeft, 3)}</td><td>${fmt(r.camberGainLeft, 3)}</td></tr>
        <tr><td>ARB twist °</td><td>${fmt(s.ubarTwistFront, 3)}</td><td>${fmt(s.ubarTwistRear, 3)}</td></tr>
        <tr><td>ARB ratio °/in</td><td>${fmt(f.arbRateLeft, 3)}</td><td>${fmt(r.arbRateLeft, 3)}</td></tr>
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
      ["U-bar / droplink", MEMBER_COLORS.ubar],
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
