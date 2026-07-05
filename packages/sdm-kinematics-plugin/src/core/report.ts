// Auto-generated optimization report (PDF via pdf-lib): study summary, per-
// parameter seed-vs-optimized comparison plots against the target, and a
// hardpoint delta table. pdf-lib is pure JS with no network APIs, so the
// bundle stays compliant with the plugin sandbox's no-network rule
// (jsPDF was rejected: its core ships XMLHttpRequest fallbacks).

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";
import type { V3 } from "./vec";
import { channelDefs, runSweep } from "./sweep";
import type { OptResult } from "./optimizer";
import { interpCurve } from "./optimizer";
import { opkName } from "./opk";

const PAGE_W = 612, PAGE_H = 792, MARGIN = 48;
const hex = (h: number): RGB => rgb(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const INK = hex(0x111827), MUTED = hex(0x6b7280), LINE = hex(0xd1d5db);
const SEED_CSS = "#2563eb", OPT_CSS = "#059669", TARGET_CSS = "#9ca3af";

interface PlotSeriesLight { label: string; data: number[]; color: string; dashed?: boolean }

/** White-background comparison chart rendered on an offscreen canvas. */
function renderChartPng(
  title: string, unit: string, xs: number[], xLabel: string, series: PlotSeriesLight[],
): string {
  const W = 900, H = 420;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const padL = 70, padR = 20, padT = 40, padB = 50;
  const pw = W - padL - padR, ph = H - padT - padB;
  let ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (const v of s.data) if (Number.isFinite(v)) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
  if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
  if (ymax - ymin < 1e-9) { ymax += 0.5; ymin -= 0.5; }
  const yr = ymax - ymin;
  ymin -= yr * 0.08; ymax += yr * 0.08;
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const X = (x: number) => padL + ((x - xmin) / (xmax - xmin || 1)) * pw;
  const Y = (y: number) => padT + (1 - (y - ymin) / (ymax - ymin)) * ph;

  ctx.strokeStyle = "#d1d5db";
  ctx.fillStyle = "#6b7280";
  ctx.font = "16px Helvetica, Arial, sans-serif";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = ymin + ((ymax - ymin) * i) / 5;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(Math.abs(ymax - ymin) < 2 ? 3 : 2), padL - 8, y + 5);
  }
  for (let i = 0; i <= 5; i++) {
    const v = xmin + ((xmax - xmin) * i) / 5;
    const x = X(v);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(v.toFixed(2), x, H - padB + 22);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 3;
    ctx.setLineDash(s.dashed ? [10, 7] : []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      const v = s.data[i];
      if (!Number.isFinite(v)) { started = false; continue; }
      const x = X(xs[i]), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "#111827";
  ctx.textAlign = "left";
  ctx.font = "bold 20px Helvetica, Arial, sans-serif";
  ctx.fillText(`${title} (${unit})`, padL, 26);
  ctx.font = "15px Helvetica, Arial, sans-serif";
  let lx = padL;
  const ly = H - 12;
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 4;
    ctx.setLineDash(s.dashed ? [8, 6] : []);
    ctx.beginPath(); ctx.moveTo(lx, ly - 5); ctx.lineTo(lx + 26, ly - 5); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#6b7280";
    ctx.fillText(s.label, lx + 32, ly);
    lx += 32 + ctx.measureText(s.label).width + 26;
  }
  ctx.textAlign = "right";
  ctx.fillStyle = "#6b7280";
  ctx.fillText(xLabel, W - padR, ly);
  return canvas.toDataURL("image/png");
}

function fmt(v: number, d = 3): string {
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

export async function generateReport(res: OptResult, opts?: { returnBytes?: boolean }): Promise<ArrayBuffer | void> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const defs = channelDefs();

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = MARGIN; // distance from the TOP; converted when drawing

  const ensureRoom = (need: number) => {
    if (y + need > PAGE_H - MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = MARGIN;
    }
  };
  const text = (s: string, x: number, o?: { size?: number; font?: PDFFont; color?: RGB }) => {
    const size = o?.size ?? 10;
    page.drawText(s, { x, y: PAGE_H - y - size, size, font: o?.font ?? helv, color: o?.color ?? INK });
  };
  const hr = () => {
    const yy = PAGE_H - y;
    page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: PAGE_W - MARGIN, y: yy }, thickness: 0.7, color: LINE });
    y += 14;
  };

  // ---- Title ----
  text("SDM Kinematics — Optimization Report", MARGIN, { size: 20, font: bold });
  y += 26;
  text("Sun Devil Motorsports · generated by the Helios SDM Kinematics plugin", MARGIN, { size: 10, color: MUTED });
  y += 20;
  hr();

  text(`Seed setup:  ${res.seedCar.name}`, MARGIN, { size: 11 });
  y += 16;
  text(`Date:  ${new Date().toLocaleString()}`, MARGIN, { size: 11 });
  y += 16;
  const enabled = res.config.points.filter((p) => p.enabled);
  text(
    `Study:  ${res.config.params.length} parameter(s) · ${enabled.length} free point(s) · ` +
    `population ${res.config.population} · ${res.config.generations} generations · RNG seed ${res.config.rngSeed}`,
    MARGIN, { size: 11 },
  );
  y += 16;
  const impr = res.seedObjective > 0
    ? (100 * (res.seedObjective - res.bestObjective)) / res.seedObjective
    : 0;
  text(
    `Objective:  seed ${fmt(res.seedObjective, 4)}  ->  optimized ${fmt(res.bestObjective, 4)}   (${impr >= 0 ? "-" : "+"}${Math.abs(impr).toFixed(1)} %)`,
    MARGIN, { size: 12, font: bold },
  );
  y += 22;
  hr();

  // ---- Parameter table ----
  text("Parameters", MARGIN, { size: 13, font: bold });
  y += 18;
  const cols = [MARGIN, MARGIN + 150, MARGIN + 265, MARGIN + 350, MARGIN + 395, MARGIN + 445, MARGIN + 495];
  const header = ["Channel", "Motion", "Target", "Weight", "Seed RMS", "Opt RMS", "Delta %"];
  header.forEach((h, i) => text(h, cols[i], { size: 9, font: bold, color: MUTED }));
  y += 13;
  res.config.params.forEach((p, i) => {
    ensureRoom(14);
    const def = defs.find((d) => d.key === p.channelKey);
    const tgt = p.target.kind === "const" ? `const ${p.target.value}` : `curve (${p.target.table.length} pts)`;
    const sc = res.perParam[i];
    const d = Number.isFinite(sc.seedErr) && sc.seedErr > 0
      ? (100 * (sc.seedErr - sc.bestErr)) / sc.seedErr : NaN;
    const row = [
      def?.label ?? p.channelKey,
      `${p.motion.type} ±${p.motion.range} x ${p.motion.steps}`,
      tgt,
      String(p.weight),
      fmt(sc.seedErr),
      fmt(sc.bestErr),
      Number.isFinite(d) ? `${d >= 0 ? "-" : "+"}${Math.abs(d).toFixed(1)}` : "—",
    ];
    row.forEach((c, j) => text(c, cols[j], { size: 9 }));
    y += 13;
  });
  y += 10;
  hr();

  // ---- Comparison plots ----
  text("Seed vs. optimized (target shown dashed)", MARGIN, { size: 13, font: bold });
  y += 16;
  const plotW = PAGE_W - 2 * MARGIN;
  const plotH = plotW * (420 / 900);
  for (const p of res.config.params) {
    const def = defs.find((d) => d.key === p.channelKey);
    if (!def) continue;
    const needs = { cornerProbes: true, axleProbes: true };
    const seedRes = runSweep(res.seedCar, p.motion, needs);
    const optRes = runSweep(res.bestCar, p.motion, needs);
    const xs = seedRes.values;
    const target = xs.map((x) => (p.target.kind === "const" ? p.target.value : interpCurve(p.target.table, x)));
    const png = renderChartPng(
      def.label, def.unit, xs, `${seedRes.paramLabel} (${seedRes.paramUnit})`,
      [
        { label: "Target", data: target, color: TARGET_CSS, dashed: true },
        { label: "Seed", data: seedRes.series.get(p.channelKey)!, color: SEED_CSS },
        { label: "Optimized", data: optRes.series.get(p.channelKey)!, color: OPT_CSS },
      ],
    );
    const img = await doc.embedPng(png);
    ensureRoom(plotH + 16);
    page.drawImage(img, { x: MARGIN, y: PAGE_H - y - plotH, width: plotW, height: plotH });
    y += plotH + 16;
  }

  // ---- Hardpoint deltas ----
  ensureRoom(80);
  hr();
  text("Hardpoint changes (left side; right is mirrored)", MARGIN, { size: 13, font: bold });
  y += 18;
  const hcols = [MARGIN, MARGIN + 45, MARGIN + 165, MARGIN + 275, MARGIN + 375, MARGIN + 475];
  ["Axle", "Point (OpK name)", "Constraint", "Seed [x y z]", "Optimized [x y z]", "|Delta| in"].forEach((h, i) =>
    text(h, hcols[i], { size: 9, font: bold, color: MUTED }),
  );
  y += 13;
  for (const p of enabled) {
    ensureRoom(14);
    const s = res.seedCar[p.axle][p.key] as V3;
    const o = res.bestCar[p.axle][p.key] as V3;
    const d = Math.hypot(o[0] - s[0], o[1] - s[1], o[2] - s[2]);
    const v3 = (v: V3) => `${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}`;
    const row = [
      p.axle === "front" ? "F" : "R",
      opkName(p.key),
      p.kind === "plane" ? `plane ±${p.ext[0]}/±${p.ext[1]}` : `box ±${p.ext.join("/±")}`,
      v3(s),
      v3(o),
      d.toFixed(4),
    ];
    row.forEach((c, j) => text(c, hcols[j], { size: 8.5 }));
    y += 13;
  }

  y += 10;
  ensureRoom(40);
  hr();
  text(
    "Actuation plane: NSMA pushrod attachment · rocker pivot (CHAS_RocPiv) · chassis shock eye (CHAS_AttPnt),",
    MARGIN, { size: 8, color: MUTED },
  );
  y += 11;
  text(
    "taken from seed geometry. Plane-constrained points mutate within a ±u/±v patch of that plane.",
    MARGIN, { size: 8, color: MUTED },
  );

  const bytes = await doc.save();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (opts?.returnBytes) return buf;
  const blob = new Blob([buf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${res.seedCar.name.replace(/\s+/g, "-")}-optimization-report.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
