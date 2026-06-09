// Light-palette design-review one-pager (P5). A pure builder: takes the already-
// computed performance numbers + the loaded tracks and returns a single self-
// contained HTML document (inline CSS + inline SVG, no external assets) that
// prints cleanly to PDF for a design review / sponsor deck. Light theme on
// purpose — the app is dark, but a report wants ink-on-white.
//
// No Tauri / React imports: unit-testable in isolation. The disk write happens
// in exportStudy.ts via io.ts (saveTextFile), same seam as every other export.

import type { VehicleConfig } from "../performance/types";
import type { EventScores } from "../performance/events";
import type { AccelResult } from "../performance/accel";
import type { SkidpadResult } from "../performance/skidpad";
import type { TractiveMap } from "../performance/tractive";
import { trackPlan, tightnessOf } from "../performance/trackGeometry";
import type { Track } from "../performance/track";

export interface DesignReportInput {
  configName: string;
  generatedAt: string; // ISO timestamp (injected — builder stays pure)
  vehicle: VehicleConfig;
  events: EventScores | null;
  accel: AccelResult | null;
  skid: SkidpadResult;
  tractive: TractiveMap | null;
  peak: { rpm: number; torqueNm: number } | null;
  autocross: Track;
  endurance: Track;
}

// Light palette for the report (distinct from the app's dark chart palette).
const INK = "#1A1D21";
const MUTED = "#5A636E";
const ACCENT = "#B8860B"; // dark goldenrod — readable on white
const GRID = "#D8DCE2";
const SERIES = { envelope: "#1A1D21", traction: "#C0392B", resistance: "#7F8C8D" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function n(v: number | null | undefined, d = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

/** Generic light-theme multi-series line chart → SVG string. */
function svgLineChart(opts: {
  width: number;
  height: number;
  xs: number[];
  series: { label: string; y: number[]; color: string }[];
  xLabel: string;
  yLabel: string;
}): string {
  const { width, height, xs, series, xLabel, yLabel } = opts;
  const padL = 52;
  const padR = 12;
  const padT = 12;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
  for (const x of xs) if (Number.isFinite(x)) { xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); }
  for (const s of series) for (const v of s.y) if (Number.isFinite(v)) { ylo = Math.min(ylo, v); yhi = Math.max(yhi, v); }
  if (!Number.isFinite(xlo)) { xlo = 0; xhi = 1; }
  if (!Number.isFinite(ylo)) { ylo = 0; yhi = 1; }
  if (ylo > 0) ylo = 0; // anchor force charts at zero
  const X = (x: number) => (xhi === xlo ? padL + plotW / 2 : padL + (plotW * (x - xlo)) / (xhi - xlo));
  const Y = (y: number) => (yhi === ylo ? padT + plotH / 2 : padT + plotH * (1 - (y - ylo) / (yhi - ylo)));

  const polys = series
    .map((s) => {
      const pts = s.y
        .map((v, i) => (Number.isFinite(v) && Number.isFinite(xs[i]!) ? `${X(xs[i]!).toFixed(1)},${Y(v).toFixed(1)}` : null))
        .filter(Boolean)
        .join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.8"/>`;
    })
    .join("");
  const legend = series
    .map((s, i) => `<text x="${padL + 6 + i * 110}" y="${padT + 10}" font-size="10" fill="${s.color}">■ ${esc(s.label)}</text>`)
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${GRID}"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="${GRID}"/>
    <text x="${padL - 6}" y="${padT + 4}" font-size="9" fill="${MUTED}" text-anchor="end">${n(yhi, 0)}</text>
    <text x="${padL - 6}" y="${padT + plotH}" font-size="9" fill="${MUTED}" text-anchor="end">${n(ylo, 0)}</text>
    <text x="${padL}" y="${padT + plotH + 14}" font-size="9" fill="${MUTED}">${n(xlo, 0)}</text>
    <text x="${padL + plotW}" y="${padT + plotH + 14}" font-size="9" fill="${MUTED}" text-anchor="end">${n(xhi, 0)}</text>
    <text x="${padL + plotW / 2}" y="${height - 6}" font-size="10" fill="${INK}" text-anchor="middle">${esc(xLabel)}</text>
    <text x="12" y="${padT + plotH / 2}" font-size="10" fill="${INK}" text-anchor="middle" transform="rotate(-90 12 ${padT + plotH / 2})">${esc(yLabel)}</text>
    ${polys}${legend}
  </svg>`;
}

/** Light-theme plan-view schematic of a track → SVG string. */
function svgTrackPlan(track: Track, width: number, height: number): string {
  const plan = trackPlan(track);
  const pad = 14;
  const { minX, minY, maxX, maxY } = plan.bbox;
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const X = (x: number) => offX + (x - minX) * scale;
  const Y = (y: number) => height - (offY + (y - minY) * scale);
  // Tightness-colored runs, but in print-friendly tones.
  const COLOR = { straight: "#2E86C1", open: "#27AE60", medium: "#B8860B", tight: "#E67E22", hairpin: "#C0392B" };
  const runs: string[] = [];
  let cur = "", buf: string[] = [], prev: string | null = null;
  for (const p of plan.points) {
    const c = COLOR[tightnessOf(p.radius)];
    const xy = `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`;
    if (c !== cur) {
      if (buf.length > 1) runs.push(`<polyline points="${buf.join(" ")}" fill="none" stroke="${cur}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);
      buf = prev ? [prev, xy] : [xy];
      cur = c;
    } else buf.push(xy);
    prev = xy;
  }
  if (buf.length > 1) runs.push(`<polyline points="${buf.join(" ")}" fill="none" stroke="${cur}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);
  const s = plan.points[0]!, f = plan.points[plan.points.length - 1]!;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF"/>
    ${runs.join("")}
    <circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.y).toFixed(1)}" r="4" fill="#27AE60"/>
    <circle cx="${X(f.x).toFixed(1)}" cy="${Y(f.y).toFixed(1)}" r="4" fill="#C0392B"/>
  </svg>`;
}

function eventsTable(ev: EventScores): string {
  const row = (name: string, metric: string, pts: number | null, max: string) =>
    `<tr><td>${esc(name)}</td><td class="muted">${esc(metric)}</td><td class="r">${n(pts)} <span class="muted">/ ${max}</span></td></tr>`;
  return `<table class="data"><thead><tr><th>Event</th><th>Sim metric</th><th class="r">Proj. points</th></tr></thead><tbody>
    ${row("Acceleration", `${n(ev.accel.timeS, 3)} s`, ev.accel.points, "100")}
    ${row("Autocross", `${n(ev.autocross.lapTimeS, 2)} s/lap`, ev.autocross.points, "125")}
    ${row("Endurance", `${n(ev.endurance.lapTimeS, 2)} s/lap · ${n(ev.endurance.co2KgPerLap * 1000, 0)} g CO₂`, ev.endurance.points, "275")}
    ${row("Efficiency", `factor ${n(ev.efficiency.factor, 3)}`, ev.efficiency.points, "100")}
    <tr class="total"><td>Total (modeled)</td><td class="muted">skidpad not modeled</td><td class="r accent">${n(ev.totalPoints)}</td></tr>
  </tbody></table>`;
}

/** Build the self-contained light-theme one-pager HTML. */
export function buildDesignReportHtml(input: DesignReportInput): string {
  const { configName, generatedAt, vehicle, events, accel, skid, tractive, peak } = input;
  const date = esc(generatedAt.slice(0, 10));

  const tractiveSvg = tractive
    ? svgLineChart({
        width: 720,
        height: 260,
        xs: tractive.speedsMps.map((v) => v * 3.6),
        series: [
          { label: "envelope (N)", y: tractive.envelopeForce, color: SERIES.envelope },
          { label: "traction limit", y: tractive.tractionLimit, color: SERIES.traction },
          { label: "drag + roll", y: tractive.resistance, color: SERIES.resistance },
        ],
        xLabel: "speed (km/h)",
        yLabel: "force (N)",
      })
    : `<p class="muted">No torque curve.</p>`;

  const spec = (label: string, value: string) =>
    `<div class="spec"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Design review — ${esc(configName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 32px; font: 13px/1.45 -apple-system, Segoe UI, Roboto, sans-serif; color: ${INK}; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: ${ACCENT}; margin: 22px 0 8px; border-bottom: 1px solid ${GRID}; padding-bottom: 4px; }
  .sub { color: ${MUTED}; font-size: 11px; margin: 0 0 4px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .spec { border: 1px solid ${GRID}; border-radius: 4px; padding: 6px 8px; }
  .spec .k { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: ${MUTED}; }
  .spec .v { font-variant-numeric: tabular-nums; font-size: 14px; }
  table.data { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  table.data th, table.data td { text-align: left; padding: 5px 8px; border-bottom: 1px solid ${GRID}; font-size: 12px; }
  table.data th { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: ${MUTED}; }
  .r { text-align: right; } .muted { color: ${MUTED}; } .accent { color: ${ACCENT}; font-size: 15px; font-weight: 600; }
  tr.total td { border-top: 2px solid ${GRID}; font-weight: 600; }
  .charts { display: grid; grid-template-columns: 1fr; gap: 12px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  figure { margin: 0; border: 1px solid ${GRID}; border-radius: 4px; padding: 6px; }
  figcaption { font-size: 10px; color: ${MUTED}; margin-top: 4px; }
  footer { margin-top: 24px; font-size: 10px; color: ${MUTED}; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } figure, table { break-inside: avoid; } }
</style></head>
<body>
  <h1>FSAE Design Review — ${esc(configName)}</h1>
  <p class="sub">${esc(vehicle.name)} · generated ${date} · Helios CFD</p>

  <h2>Vehicle</h2>
  <div class="grid">
    ${spec("Mass", `${n(vehicle.massKg, 0)} kg`)}
    ${spec("Final drive", n(vehicle.finalDrive, 2))}
    ${spec("μ lat / long", `${n(vehicle.muLat, 2)} / ${n(vehicle.muLong, 2)}`)}
    ${spec("Peak torque", peak ? `${n(peak.torqueNm, 1)} Nm @ ${n(peak.rpm, 0)}` : "—")}
    ${spec("Accel (75 m)", accel ? `${n(accel.timeS, 3)} s` : "—")}
    ${spec("Trap speed", accel ? `${n(accel.trapSpeedMps * 3.6, 1)} km/h` : "—")}
    ${spec("Skidpad", `${n(skid.speedKph, 1)} km/h · ${n(skid.lateralG, 2)} g`)}
    ${spec("Rev limit", `${n(vehicle.revLimitRpm, 0)} rpm`)}
  </div>

  <h2>FSAE Events — projected</h2>
  ${events ? eventsTable(events) : `<p class="muted">No torque curve — run a sweep or optimization.</p>`}

  <h2>Tractive Effort</h2>
  <figure>${tractiveSvg}<figcaption>Tractive force vs speed — per-gear envelope, tire-traction limit, and drag + rolling resistance.</figcaption></figure>

  <h2>Courses (2026)</h2>
  <div class="two">
    <figure>${svgTrackPlan(input.autocross, 350, 200)}<figcaption>${esc(input.autocross.name)} — schematic (turn directions approximated; tightness/lengths real).</figcaption></figure>
    <figure>${svgTrackPlan(input.endurance, 350, 200)}<figcaption>${esc(input.endurance.name)} — schematic.</figcaption></figure>
  </div>

  <footer>Projected points use frontend FSAE scoring against the 2026 field anchors. Lap times are estimates (driver/tire/conditions vary). Track plan views are schematic — the model is corner-direction-agnostic.</footer>
</body></html>`;
}
