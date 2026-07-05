// Optimizer overlay — point/constraint selection, parameter studies with
// constant or curve targets, run control with live progress, and results
// (apply / revert / PDF report). Pure DOM in the COAST card style.

import type { AxleGeometry } from "../core/model";
import { HARDPOINT_KEYS } from "../core/model";
import { channelDefs, type SweepType } from "../core/sweep";
import {
  ACTUATION_KEYS, defaultPointOpts,
  type CurvePoint, type OptParameter, type OptProgress, type OptResult,
  type OptimizerConfig, type PointOpt,
} from "../core/optimizer";
import { opkName } from "../core/opk";

export interface OptimizerCallbacks {
  onRun(config: OptimizerConfig): void;
  onCancel(): void;
  onApply(): void;
  onRevert(): void;
  onReport(): void;
}

interface ParamRow {
  channelKey: string;
  motionType: SweepType;
  range: number;
  steps: number;
  targetKind: "const" | "curve";
  constValue: number;
  curve: CurvePoint[];
  weight: number;
}

const fmt = (v: number, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export class OptimizerPanel {
  private points: PointOpt[] = defaultPointOpts();
  private params: ParamRow[] = [{
    channelKey: "camber_FL",
    motionType: "heave", range: 1, steps: 9,
    targetKind: "const", constValue: -1.5,
    curve: [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: -2.5 }],
    weight: 1,
  }];
  private population = 20;
  private generations = 25;
  private rngSeed = 1;
  private running = false;
  private hasResult = false;

  private body!: HTMLElement;
  private progressBar!: HTMLElement;
  private progressText!: HTMLElement;
  private spark!: HTMLCanvasElement;
  private resultText!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private resultBtns: HTMLButtonElement[] = [];

  constructor(private root: HTMLElement, private cb: OptimizerCallbacks) {}

  open(): void {
    this.root.style.display = "block";
    this.render();
  }

  close(): void {
    this.root.style.display = "none";
  }

  getConfig(): OptimizerConfig {
    return {
      points: this.points.map((p) => ({ ...p, ext: [...p.ext] as [number, number, number] })),
      params: this.params.map((r): OptParameter => ({
        channelKey: r.channelKey,
        motion: { type: r.motionType, range: r.range, steps: r.steps },
        target: r.targetKind === "const"
          ? { kind: "const", value: r.constValue }
          : { kind: "curve", table: r.curve.map((c) => ({ ...c })) },
        weight: r.weight,
      })),
      population: this.population,
      generations: this.generations,
      rngSeed: this.rngSeed,
    };
  }

  setRunning(on: boolean): void {
    this.running = on;
    this.runBtn.disabled = on;
    this.cancelBtn.disabled = !on;
  }

  showProgress(p: OptProgress): void {
    const frac = p.generations > 0 ? p.generation / p.generations : 0;
    this.progressBar.style.width = `${Math.round(frac * 100)}%`;
    const impr = p.seedObjective > 0
      ? (100 * (p.seedObjective - p.bestObjective)) / p.seedObjective : 0;
    this.progressText.textContent =
      `gen ${p.generation}/${p.generations} · ${p.evals} evals · best ${fmt(p.bestObjective)} ` +
      `(seed ${fmt(p.seedObjective)}, −${Math.max(0, impr).toFixed(1)} %)`;
    this.drawSpark(p.history);
  }

  showResult(res: OptResult): void {
    this.hasResult = true;
    this.setRunning(false);
    const impr = res.seedObjective > 0
      ? (100 * (res.seedObjective - res.bestObjective)) / res.seedObjective : 0;
    this.resultText.innerHTML =
      `<b>Done.</b> Objective ${fmt(res.seedObjective)} → <b class="val-good">${fmt(res.bestObjective)}</b> ` +
      `(−${Math.max(0, impr).toFixed(1)} %) · ` +
      res.config.params.map((p, i) => {
        const d = channelDefs().find((dd) => dd.key === p.channelKey);
        return `${d?.label ?? p.channelKey}: ${fmt(res.perParam[i].seedErr, 3)}→${fmt(res.perParam[i].bestErr, 3)}`;
      }).join(" · ");
    for (const b of this.resultBtns) b.disabled = false;
  }

  private drawSpark(history: number[]): void {
    const c = this.spark;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 300, h = 46;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const finite = history.filter(Number.isFinite);
    if (finite.length < 2) return;
    const min = Math.min(...finite), max = Math.max(...finite);
    ctx.strokeStyle = "#4ea1ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    history.forEach((v, i) => {
      const x = (i / (history.length - 1)) * (w - 4) + 2;
      const y = 4 + (1 - (v - min) / (max - min || 1)) * (h - 8);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // -------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = "";
    const head = document.createElement("div");
    head.className = "sweep-head";
    const title = document.createElement("div");
    title.innerHTML = `<b>Optimizer</b> <span class="small">targets + weights · box / actuation-plane mutation bounds</span>`;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.onclick = () => this.close();
    head.append(title, closeBtn);
    this.root.appendChild(head);

    this.body = document.createElement("div");
    this.body.style.display = "grid";
    this.body.style.gridTemplateColumns = "minmax(340px, 1fr) minmax(380px, 1.2fr)";
    this.body.style.gap = "10px";
    this.root.appendChild(this.body);

    this.body.append(this.pointsCard(), this.rightColumn());
  }

  private card(title: string): HTMLElement {
    const c = document.createElement("div");
    c.className = "card";
    const h = document.createElement("h2");
    h.textContent = title;
    c.appendChild(h);
    return c;
  }

  private numInput(value: number, step: number, width: number, onChange: (v: number) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "number";
    i.step = String(step);
    i.value = String(value);
    i.style.width = `${width}px`;
    i.style.background = "var(--bg)";
    i.style.color = "var(--text)";
    i.style.border = "1px solid var(--line)";
    i.style.borderRadius = "6px";
    i.style.padding = "3px 5px";
    i.style.fontSize = "11px";
    i.onchange = () => {
      const v = Number(i.value);
      if (Number.isFinite(v)) onChange(v);
    };
    return i;
  }

  // ---- Points & constraints ----
  private pointsCard(): HTMLElement {
    const c = this.card("Points & mutation bounds");
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginBottom = "6px";
    note.innerHTML =
      "Toggle points into the study. <b>Box</b>: ±x/±y/±z around seed. " +
      "<b>Actuation plane</b> (pushrod/rocker/shock points): mutations stay in the plane " +
      "NSMA_PPAttPnt · CHAS_RocPiv · CHAS_AttPnt, within ±u/±v.";
    c.appendChild(note);

    for (const axle of ["front", "rear"] as const) {
      const h = document.createElement("div");
      h.className = "small";
      h.style.cssText = "font-weight:600;color:var(--text);margin:8px 0 4px;text-transform:uppercase;letter-spacing:1px;font-size:10px";
      h.textContent = axle === "front" ? "Front axle" : "Rear axle";
      c.appendChild(h);
      for (const p of this.points.filter((pp) => pp.axle === axle)) {
        c.appendChild(this.pointRow(p));
      }
    }
    return c;
  }

  private pointRow(p: PointOpt): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:5px;padding:2px 0;flex-wrap:wrap";

    const cbLab = document.createElement("label");
    cbLab.className = "toggle";
    cbLab.style.flex = "0 0 172px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = p.enabled;
    cb.onchange = () => { p.enabled = cb.checked; };
    const lab = HARDPOINT_KEYS.find((k) => k.key === p.key)?.label ?? String(p.key);
    cbLab.append(cb, document.createTextNode(lab));
    cbLab.title = opkName(p.key);
    row.appendChild(cbLab);

    const isAct = ACTUATION_KEYS.includes(p.key);
    const kind = document.createElement("select");
    kind.style.cssText = "background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px;font-size:11px";
    for (const [v, l] of [["box", "Box"], ["plane", "Actuation plane"]] as const) {
      if (v === "plane" && !isAct) continue;
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      kind.appendChild(o);
    }
    kind.value = p.kind;
    row.appendChild(kind);

    const extWrap = document.createElement("span");
    extWrap.style.cssText = "display:inline-flex;gap:3px;align-items:center";
    const renderExt = () => {
      extWrap.innerHTML = "";
      const labels = p.kind === "plane" ? ["±u", "±v"] : ["±x", "±y", "±z"];
      labels.forEach((l, i) => {
        const s = document.createElement("span");
        s.className = "small";
        s.textContent = l;
        extWrap.appendChild(s);
        extWrap.appendChild(this.numInput(p.ext[i], 0.1, 44, (v) => { p.ext[i] = Math.abs(v); }));
      });
    };
    kind.onchange = () => {
      p.kind = kind.value as "box" | "plane";
      renderExt();
    };
    renderExt();
    row.appendChild(extWrap);
    return row;
  }

  // ---- Parameters + run ----
  private rightColumn(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:10px";

    const pc = this.card("Parameters (channel · motion · target · weight)");
    const list = document.createElement("div");
    pc.appendChild(list);
    const renderParams = () => {
      list.innerHTML = "";
      this.params.forEach((r, i) => list.appendChild(this.paramRow(r, i, renderParams)));
    };
    renderParams();
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add parameter";
    addBtn.style.marginTop = "6px";
    addBtn.onclick = () => {
      this.params.push({
        channelKey: "toe_FL", motionType: "heave", range: 1, steps: 9,
        targetKind: "const", constValue: 0,
        curve: [{ x: -1, y: 0 }, { x: 1, y: 0 }], weight: 1,
      });
      renderParams();
    };
    pc.appendChild(addBtn);
    wrap.appendChild(pc);

    // Run card
    const rc = this.card("Run");
    const row = document.createElement("div");
    row.className = "row";
    row.style.alignItems = "center";
    const mk = (lab: string, val: number, step: number, on: (v: number) => void) => {
      const s = document.createElement("span");
      s.className = "small";
      s.textContent = lab;
      row.append(s, this.numInput(val, step, 56, on));
    };
    mk("Population", this.population, 1, (v) => (this.population = Math.max(4, Math.round(v))));
    mk("Generations", this.generations, 1, (v) => (this.generations = Math.max(1, Math.round(v))));
    mk("RNG seed", this.rngSeed, 1, (v) => (this.rngSeed = Math.round(v)));
    rc.appendChild(row);

    const btns = document.createElement("div");
    btns.className = "row";
    btns.style.marginTop = "8px";
    this.runBtn = document.createElement("button");
    this.runBtn.className = "primary";
    this.runBtn.textContent = "Run optimization";
    this.runBtn.onclick = () => this.cb.onRun(this.getConfig());
    this.cancelBtn = document.createElement("button");
    this.cancelBtn.textContent = "Stop";
    this.cancelBtn.disabled = true;
    this.cancelBtn.onclick = () => this.cb.onCancel();
    btns.append(this.runBtn, this.cancelBtn);
    rc.appendChild(btns);

    const barWrap = document.createElement("div");
    barWrap.style.cssText = "background:var(--bg);border:1px solid var(--line);border-radius:6px;height:10px;margin-top:8px;overflow:hidden";
    this.progressBar = document.createElement("div");
    this.progressBar.style.cssText = "height:100%;width:0%;background:var(--accent);transition:width 0.2s";
    barWrap.appendChild(this.progressBar);
    rc.appendChild(barWrap);
    this.progressText = document.createElement("div");
    this.progressText.className = "small";
    this.progressText.style.marginTop = "4px";
    rc.appendChild(this.progressText);
    this.spark = document.createElement("canvas");
    this.spark.style.cssText = "width:100%;height:46px;margin-top:6px;background:var(--bg);border:1px solid var(--line);border-radius:6px";
    rc.appendChild(this.spark);
    wrap.appendChild(rc);

    // Results card
    const res = this.card("Results");
    this.resultText = document.createElement("div");
    this.resultText.className = "small";
    this.resultText.textContent = "Run a study to see results.";
    res.appendChild(this.resultText);
    const rrow = document.createElement("div");
    rrow.className = "row";
    rrow.style.marginTop = "8px";
    const applyB = document.createElement("button");
    applyB.className = "primary";
    applyB.textContent = "Apply optimized geometry";
    applyB.onclick = () => this.cb.onApply();
    const revertB = document.createElement("button");
    revertB.textContent = "Revert to seed";
    revertB.onclick = () => this.cb.onRevert();
    const pdfB = document.createElement("button");
    pdfB.textContent = "Generate PDF report";
    pdfB.onclick = () => this.cb.onReport();
    this.resultBtns = [applyB, revertB, pdfB];
    for (const b of this.resultBtns) b.disabled = !this.hasResult;
    rrow.append(applyB, revertB, pdfB);
    res.appendChild(rrow);
    wrap.appendChild(res);

    return wrap;
  }

  private paramRow(r: ParamRow, idx: number, rerender: () => void): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px;background:var(--bg)";

    const top = document.createElement("div");
    top.style.cssText = "display:flex;gap:5px;align-items:center;flex-wrap:wrap";

    const chan = document.createElement("select");
    chan.style.cssText = "background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px;font-size:11px;max-width:160px";
    for (const d of channelDefs()) {
      const o = document.createElement("option");
      o.value = d.key;
      o.textContent = `${d.label} (${d.unit})`;
      chan.appendChild(o);
    }
    chan.value = r.channelKey;
    chan.onchange = () => (r.channelKey = chan.value);

    const motion = document.createElement("select");
    motion.style.cssText = chan.style.cssText;
    for (const [v, l] of [["heave", "Heave"], ["roll", "Roll"], ["pitch", "Pitch"], ["steer", "Steer"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      motion.appendChild(o);
    }
    motion.value = r.motionType;
    motion.onchange = () => (r.motionType = motion.value as SweepType);

    const lab = (t: string) => {
      const s = document.createElement("span");
      s.className = "small";
      s.textContent = t;
      return s;
    };
    top.append(
      chan, motion,
      lab("±"), this.numInput(r.range, 0.1, 46, (v) => (r.range = Math.abs(v))),
      lab("steps"), this.numInput(r.steps, 1, 42, (v) => (r.steps = Math.max(3, Math.round(v)))),
      lab("weight"), this.numInput(r.weight, 0.1, 46, (v) => (r.weight = v)),
    );
    const del = document.createElement("button");
    del.textContent = "✕";
    del.style.cssText = "padding:2px 7px;margin-left:auto";
    del.onclick = () => {
      this.params.splice(idx, 1);
      rerender();
    };
    top.appendChild(del);
    box.appendChild(top);

    // Target row
    const tgt = document.createElement("div");
    tgt.style.cssText = "display:flex;gap:5px;align-items:flex-start;margin-top:6px;flex-wrap:wrap";
    const kind = document.createElement("select");
    kind.style.cssText = chan.style.cssText;
    for (const [v, l] of [["const", "Target: constant"], ["curve", "Target: curve"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      kind.appendChild(o);
    }
    kind.value = r.targetKind;
    const tgtBody = document.createElement("div");
    tgtBody.style.flex = "1";
    const renderTarget = () => {
      tgtBody.innerHTML = "";
      if (r.targetKind === "const") {
        tgtBody.append(this.numInput(r.constValue, 0.1, 70, (v) => (r.constValue = v)));
      } else {
        const tbl = document.createElement("div");
        r.curve.forEach((cp, i) => {
          const line = document.createElement("div");
          line.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:2px";
          const xl = lab("x"); const yl = lab("y");
          line.append(
            xl, this.numInput(cp.x, 0.1, 56, (v) => (cp.x = v)),
            yl, this.numInput(cp.y, 0.1, 56, (v) => (cp.y = v)),
          );
          const rm = document.createElement("button");
          rm.textContent = "–";
          rm.style.cssText = "padding:1px 7px";
          rm.onclick = () => {
            r.curve.splice(i, 1);
            renderTarget();
          };
          line.appendChild(rm);
          tbl.appendChild(line);
        });
        const addRow = document.createElement("button");
        addRow.textContent = "+ row";
        addRow.style.cssText = "padding:2px 8px;font-size:11px";
        addRow.onclick = () => {
          const last = r.curve[r.curve.length - 1];
          r.curve.push({ x: (last?.x ?? 0) + 0.5, y: last?.y ?? 0 });
          renderTarget();
        };
        tbl.appendChild(addRow);
        tgtBody.appendChild(tbl);
      }
    };
    kind.onchange = () => {
      r.targetKind = kind.value as "const" | "curve";
      renderTarget();
    };
    renderTarget();
    tgt.append(kind, tgtBody);
    box.appendChild(tgt);
    return box;
  }
}
