// Master engineering report (Ansys-style): one self-contained light-theme HTML
// document that expands the WHOLE workspace — executive summary, methodology,
// a cross-design comparison, every sweep (curves + per-RPM data + dyno
// validation), every optimization (convergence + top designs + sensitivity +
// knock), the best design's FSAE deep-dive with lap telemetry, the courses,
// and a study registry appendix. Numbered sections + a linked TOC; print CSS
// paginates each top-level section. Open in a browser and print to PDF.
//
// Pure builder (no Tauri/React): scoring is recomputed here through the SAME
// production chain (computeEvents / vehicleForCar / sourcesFrom) so the report
// can never disagree with the app. `only` scopes the document to one study
// (the per-screen "Report" exports); omitted = the full master report.

import type { Study, SweepStudy, OptimizationStudy } from "../../state/types";
import type { ReferenceBaseline, VehicleConfig } from "../performance/types";
import {
  carKeyForConfig,
  vehicleForCar,
  torqueCurveFromSweep,
  peakTorque,
  computeEvents,
  simAccel,
  simLap,
  autocrossLapOpts,
  enduranceLapOpts,
  predictSkidpad,
  fuelMapFromSweep,
  cornerSignsAtFracs,
  tractiveMap,
  AUTOCROSS_2026,
  ENDURANCE_2026,
  AUTOCROSS_2026_VISUAL,
  ENDURANCE_2026_VISUAL,
  type EventScores,
  type LapChannels,
  type LapResult,
  type LapTelemetry,
  type LimitState,
} from "../performance";
import { sourcesFrom, type CurveSource } from "../curveSources";
import { studyName } from "../studyName";
import { rankTrials, sensitivityTornado } from "../analytics/optimizationStats";
import { compareDyno } from "../analytics/dynoCompare";
import { dynoPowerKw } from "../import/importDyno";
import { lapSectors } from "../performance/sectors";
import { INK, MUTED, ACCENT, GRID, esc, n, eventsTable, svgVisualTrack } from "./designReport";

export interface MasterReportInput {
  generatedAt: string; // ISO (injected — builder stays pure)
  studies: Record<string, Study>;
  vehicleConfig: VehicleConfig | null;
  referenceBaseline: ReferenceBaseline;
  /** Scope the report to these study ids (per-screen / pinned-set exports). */
  only?: string[];
  title?: string;
}

const PALETTE = ["#B8860B", "#2E86C1", "#27AE60", "#C0392B", "#8E44AD", "#E67E22", "#16A085", "#7F8C8D"];

// --- generic chart with per-series x (overlays mix rpm grids) ---------------
interface XYSeries { label: string; xs: number[]; y: number[]; color: string; dashed?: boolean }

function svgXYChart(opts: {
  width: number; height: number; series: XYSeries[]; xLabel: string; yLabel: string; zeroY?: boolean;
}): string {
  const { width, height, series, xLabel, yLabel } = opts;
  const padL = 52, padR = 12, padT = 14, padB = 34;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
  for (const s of series) {
    for (const x of s.xs) if (Number.isFinite(x)) { xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); }
    for (const v of s.y) if (Number.isFinite(v)) { ylo = Math.min(ylo, v); yhi = Math.max(yhi, v); }
  }
  if (!Number.isFinite(xlo)) { xlo = 0; xhi = 1; }
  if (!Number.isFinite(ylo)) { ylo = 0; yhi = 1; }
  if (opts.zeroY !== false && ylo > 0) ylo = 0;
  const X = (x: number) => (xhi === xlo ? padL + plotW / 2 : padL + (plotW * (x - xlo)) / (xhi - xlo));
  const Y = (y: number) => (yhi === ylo ? padT + plotH / 2 : padT + plotH * (1 - (y - ylo) / (yhi - ylo)));
  const polys = series.map((s) => {
    const pts = s.y
      .map((v, i) => (Number.isFinite(v) && Number.isFinite(s.xs[i]!) ? `${X(s.xs[i]!).toFixed(1)},${Y(v).toFixed(1)}` : null))
      .filter(Boolean).join(" ");
    const dash = s.dashed ? ' stroke-dasharray="5 3"' : "";
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.8"${dash} stroke-linejoin="round"/>`;
  }).join("");
  // Gridlines + tick labels (4 intervals each way) — a chart you can read
  // numbers off, not just a shape.
  const ticks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const ty = padT + (plotH * i) / 4;
    const yv = yhi - ((yhi - ylo) * i) / 4;
    ticks.push(`<line x1="${padL}" y1="${ty.toFixed(1)}" x2="${padL + plotW}" y2="${ty.toFixed(1)}" stroke="${i === 4 ? GRID : "#EDF0F3"}"/>`);
    ticks.push(`<text x="${padL - 6}" y="${(ty + 3).toFixed(1)}" font-size="8.5" fill="${MUTED}" text-anchor="end">${n(yv, Math.abs(yhi - ylo) < 8 ? 1 : 0)}</text>`);
    const tx = padL + (plotW * i) / 4;
    const xv = xlo + ((xhi - xlo) * i) / 4;
    if (i > 0) ticks.push(`<line x1="${tx.toFixed(1)}" y1="${padT}" x2="${tx.toFixed(1)}" y2="${padT + plotH}" stroke="#F3F5F7"/>`);
    ticks.push(`<text x="${tx.toFixed(1)}" y="${padT + plotH + 13}" font-size="8.5" fill="${MUTED}" text-anchor="middle">${n(xv, 0)}</text>`);
  }
  // Legend box, top-right inside the plot.
  const legW = Math.min(220, Math.max(...series.map((s) => s.label.length)) * 5.4 + 28);
  const legX = padL + plotW - legW - 4;
  const legend = `<g>
    <rect x="${legX}" y="${padT + 3}" width="${legW}" height="${series.length * 13 + 8}" fill="#FFFFFF" fill-opacity="0.92" stroke="${GRID}" rx="3"/>
    ${series.map((s, i) => `
      <line x1="${legX + 8}" y1="${padT + 13 + i * 13}" x2="${legX + 24}" y2="${padT + 13 + i * 13}" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 3"' : ""}/>
      <text x="${legX + 29}" y="${padT + 16 + i * 13}" font-size="9" fill="${INK}">${esc(s.label)}</text>`).join("")}
  </g>`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#FFFFFF"/>
    ${ticks.join("")}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${MUTED}" stroke-width="0.8"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="${MUTED}" stroke-width="0.8"/>
    <text x="${padL + plotW / 2}" y="${height - 6}" font-size="10" fill="${INK}" text-anchor="middle" font-weight="600">${esc(xLabel)}</text>
    <text x="12" y="${padT + plotH / 2}" font-size="10" fill="${INK}" text-anchor="middle" font-weight="600" transform="rotate(-90 12 ${padT + plotH / 2})">${esc(yLabel)}</text>
    ${polys}${legend}
  </svg>`;
}

const fig = (svg: string, caption: string) => `<figure>${svg}<figcaption>${esc(caption)}</figcaption></figure>`;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

// --- per-source scoring (the same chain as every screen) --------------------
interface Scored {
  source: CurveSource;
  vehicle: VehicleConfig;
  events: EventScores;
  peak: { rpm: number; torqueNm: number } | null;
}

function scoreSources(sources: CurveSource[], vehicleConfig: VehicleConfig | null, baseline: ReferenceBaseline): Scored[] {
  return sources.map((source) => {
    const vehicle = vehicleForCar(carKeyForConfig(source.configName), vehicleConfig ?? undefined);
    const curve = torqueCurveFromSweep(source.points);
    return { source, vehicle, events: computeEvents(curve, vehicle, baseline), peak: peakTorque(curve) };
  });
}

// --- sections ----------------------------------------------------------------

function executiveSummary(scored: Scored[]): string {
  if (scored.length === 0) return `<p class="muted">No completed studies with torque curves.</p>`;
  const bestTotal = Math.max(...scored.map((s) => s.events.totalPoints ?? -Infinity));
  const rows = scored.map((s) => {
    const t = s.events.totalPoints;
    const best = t != null && t === bestTotal;
    return `<tr${best ? ' class="total"' : ""}><td>${esc(studyLabel(s.source))}</td>
      <td class="r">${s.peak ? `${n(s.peak.torqueNm)} Nm @ ${n(s.peak.rpm, 0)}` : "—"}</td>
      <td class="r">${n(s.events.accel.timeS, 3)}</td>
      <td class="r">${n(s.events.autocross.lapTimeS, 2)}</td>
      <td class="r">${n(s.events.endurance.lapTimeS, 2)}</td>
      <td class="r">${n(s.events.efficiency.points)}</td>
      <td class="r${best ? " accent" : ""}">${n(t)}${best ? " ★" : ""}</td></tr>`;
  }).join("");
  const bestS = scored.find((s) => s.events.totalPoints === bestTotal);
  const cards = bestS ? `<div class="cards">
    <div class="card"><span class="k">Best design</span><span class="v">${esc(studyLabel(bestS.source))}</span></div>
    <div class="card"><span class="k">Projected total</span><span class="v accent">${n(bestS.events.totalPoints)} pts</span></div>
    <div class="card"><span class="k">Peak power</span><span class="v">${bestS.peak ? `${n(bestS.peak.torqueNm)} Nm @ ${n(bestS.peak.rpm, 0)}` : "—"}</span></div>
    <div class="card"><span class="k">Designs scored</span><span class="v">${scored.length}</span></div>
  </div>` : "";
  return `${cards}<table class="data"><thead><tr><th>Design</th><th class="r">peak τ</th><th class="r">accel (s)</th>
    <th class="r">AX (s)</th><th class="r">EN (s/lap)</th><th class="r">eff pts</th><th class="r">total pts</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function studyLabel(source: CurveSource): string {
  return source.label.replace(/^(Sweep|Optimization) · /, "");
}

function methodology(baseline: ReferenceBaseline): string {
  return `<p>Engine curves come from the Helios 1-D finite-volume engine simulator (MUSCL-Hancock + HLLC,
    characteristic junctions, dyno-validated physics — RMSE ≈ 4.3 kW vs the team Dynojet reference).
    Vehicle events use a quasi-steady-state lap simulation (corner/forward/backward speed solve with lateral
    load transfer, rear-axle drive traction, and optimal shift scheduling) over the traced 2026 competition
    courses. FSAE points are projected against the ${baseline.enduranceTMin ? "2026 field reference anchors" : "configured baseline"}.</p>
    <p class="muted">Calibration anchors: SDM26 autocross 42.922 s (real 2026 run); endurance pace and fuel
    anchored to Colorado School of Mines' official run-average (159.6 s/lap, 0.9786 kg CO₂/lap on E85) —
    the same corrected-total convention as the scoring baselines. Known limits: exhaust-length tuning
    response is damped (solver-class), absolute peak power at the rev limit is under-predicted, and lap
    times assume a consistent driver on warm tires.</p>`;
}

function sweepSection(study: SweepStudy, vehicleConfig: VehicleConfig | null, baseline: ReferenceBaseline): string {
  const points = [...study.points].sort((a, b) => a.rpm - b.rpm);
  if (points.length === 0) return `<p class="muted">No completed RPM points.</p>`;
  const xs = points.map((p) => p.rpm);
  const series: XYSeries[] = [
    { label: "brake power (kW)", xs, y: points.map((p) => p.lastCycle.brakePowerKW), color: PALETTE[0]! },
    { label: "brake torque (Nm)", xs, y: points.map((p) => p.lastCycle.brakeTorqueNm), color: PALETTE[1]! },
  ];
  let dynoBlock = "";
  if (study.dynoRef) {
    const dp = study.dynoRef.points
      .map((d) => ({ rpm: d.rpm, v: dynoPowerKw(d) }))
      .filter((d): d is { rpm: number; v: number } => d.v != null);
    if (dp.length) {
      series.push({ label: `dyno: ${study.dynoRef.label}`, xs: dp.map((d) => d.rpm), y: dp.map((d) => d.v), color: PALETTE[3]!, dashed: true });
    }
    // Wheel-vs-wheel: a chassis dyno measures downstream of the driveline.
    const cmp = compareDyno(points.map((p) => ({ rpm: p.rpm, powerKw: p.lastCycle.wheelPowerKW })), study.dynoRef.points);
    dynoBlock = cmp
      ? `<p><strong>Dyno validation:</strong> RMSE ${n(cmp.rmseKw, 2)} kW, bias ${cmp.biasKw >= 0 ? "+" : ""}${n(cmp.biasKw, 2)} kW
         (sim wheel power − dyno) over ${cmp.n} points, ${n(cmp.rpmMin, 0)}–${n(cmp.rpmMax, 0)} rpm.</p>`
      : `<p class="muted">Dyno reference attached but no overlapping RPM band.</p>`;
  }
  const hasKi = points.some((p) => p.lastCycle.knockIntegral != null);
  const rows = points.map((p) => `<tr><td class="r">${n(p.rpm, 0)}</td>
    <td class="r">${n(p.lastCycle.brakePowerKW)}</td><td class="r">${n(p.lastCycle.brakeTorqueNm)}</td>
    <td class="r">${n(p.lastCycle.veAtm, 3)}</td><td class="r">${n(p.lastCycle.egtMean, 0)}</td>
    ${hasKi ? `<td class="r">${p.lastCycle.knockIntegral != null ? (p.lastCycle.knockIntegral > 1 ? `<span class="bad">⚠ ${n(p.lastCycle.knockIntegral, 2)}</span>` : n(p.lastCycle.knockIntegral, 2)) : "—"}</td>` : ""}
    </tr>`).join("");
  return `
    <p class="muted">Config ${esc(study.configPath)} · ${points.length} rpm points · junction ${esc(study.params.junctionKind)} ·
      run ${esc(new Date(study.startedAt).toISOString().slice(0, 10))} · status ${esc(study.status)}</p>
    ${fig(svgXYChart({ width: 720, height: 280, series, xLabel: "rpm", yLabel: "kW / Nm" }), "Brake power and torque vs RPM" + (study.dynoRef ? " with the imported dyno reference (dashed)" : ""))}
    ${dynoBlock}
    <table class="data"><thead><tr><th class="r">rpm</th><th class="r">BP (kW)</th><th class="r">τ (Nm)</th>
      <th class="r">VE</th><th class="r">EGT (K)</th>${hasKi ? '<th class="r">KI</th>' : ""}</tr></thead><tbody>${rows}</tbody></table>`;
}

function optimizationSection(study: OptimizationStudy): string {
  const done = study.trials
    .filter((t) => t.status === "done" && t.objectiveValue != null)
    .sort((a, b) => a.trialIdx - b.trialIdx); // best-so-far is only correct in trial order
  if (done.length === 0) return `<p class="muted">No completed trials.</p>`;
  // Convergence: objective per trial + best-so-far envelope.
  const sign = study.objectiveDirection === "maximize" ? 1 : -1;
  let best = -Infinity;
  const bestSoFar = done.map((t) => {
    best = Math.max(best, sign * (t.objectiveValue as number));
    return sign * best === 0 ? 0 : best * sign;
  });
  const convergence = svgXYChart({
    width: 720, height: 240, zeroY: false,
    series: [
      { label: "trial objective", xs: done.map((t) => t.trialIdx), y: done.map((t) => t.objectiveValue as number), color: GRID },
      { label: "best so far", xs: done.map((t) => t.trialIdx), y: bestSoFar, color: PALETTE[0]! },
    ],
    xLabel: "trial", yLabel: esc(study.params.objective.metric),
  });
  const ranked = rankTrials(study.trials, study.objectiveDirection).slice(0, 10);
  const kiOf = (t: (typeof study.trials)[number]) => {
    let max: number | null = null;
    for (const p of t.sweepPoints ?? []) {
      const ki = p.lastCycle.knockIntegral;
      if (ki != null && (max == null || ki > max)) max = ki;
    }
    return max;
  };
  const rows = ranked.map((r) => {
    const ki = kiOf(r.trial);
    return `<tr><td class="r">${r.rank}</td><td class="r">#${r.trial.trialIdx}</td>
      <td class="r">${n(r.trial.objectiveValue, 4)}</td>
      <td class="r">${ki == null ? "—" : ki > 1 ? `<span class="bad">⚠ ${n(ki, 2)}</span>` : n(ki, 2)}</td>
      <td>${study.parameterPaths.map((p) => `${esc(p.split(".").pop() ?? p)}=${n(r.trial.parameterValues[p], 4)}`).join(" · ")}</td></tr>`;
  }).join("");
  const sens = sensitivityTornado(study.trials, study.parameterPaths);
  const sensRows = sens.map((e) =>
    `<tr><td>${esc(e.path)}</td><td class="r">${e.rho >= 0 ? "+" : ""}${n(e.rho, 3)}</td><td class="r">${e.n}</td></tr>`,
  ).join("");
  return `
    <p class="muted">Config ${esc(study.configPath)} · objective ${esc(study.params.objective.metric)} (${esc(study.objectiveDirection)}) ·
      sampler ${esc(study.params.sampler)} · ${done.length}/${study.params.nTrials} trials ·
      run ${esc(new Date(study.startedAt).toISOString().slice(0, 10))}</p>
    ${fig(convergence, "Objective per trial with the best-so-far envelope (space-filling sampler).")}
    <h3>Top designs</h3>
    <table class="data"><thead><tr><th class="r">rank</th><th class="r">trial</th><th class="r">objective</th><th class="r">KI max</th><th>parameters</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>Parameter sensitivity (Spearman ρ vs objective)</h3>
    <table class="data"><thead><tr><th>parameter</th><th class="r">ρ</th><th class="r">n</th></tr></thead><tbody>${sensRows}</tbody></table>
    <p class="muted">KI = max Livengood–Wu knock integral over the trial's RPM band; ⚠ marks I &gt; 1.0 (knock predicted).</p>`;
}

function telemetryTable(label: string, t: LapTelemetry): string {
  const gears = t.timeInGearFrac.map((f, i) => (f > 0.005 ? `${i + 1}:${pct(f)}` : null)).filter(Boolean).join(" ");
  return `<tr><td>${esc(label)}</td><td class="r">${n(t.avgRpm, 0)}</td><td class="r">${n(t.maxRpm, 0)}</td>
    <td class="r">${t.shiftCount}</td><td class="r">${n(t.maxLatG, 2)}</td><td class="r">${n(t.maxAccelG, 2)}</td>
    <td class="r">${n(t.maxBrakeG, 2)}</td><td class="r">${pct(t.pctOnThrottle)}</td>
    <td class="r">${pct(t.pctPowerLimited)}</td><td class="r">${pct(t.pctCornerLimited)}</td><td>${esc(gears)}</td></tr>`;
}

function bestDesignSection(scored: Scored[]): string {
  const withPts = scored.filter((s) => s.events.totalPoints != null);
  const best = withPts.length
    ? withPts.reduce((a, b) => ((b.events.totalPoints as number) > (a.events.totalPoints as number) ? b : a))
    : scored[0];
  if (!best) return `<p class="muted">No scorable design.</p>`;
  const curve = torqueCurveFromSweep(best.source.points);
  const tr = tractiveMap(curve, best.vehicle);
  const accel = simAccel(curve, best.vehicle);
  const tel = `<table class="data"><thead><tr><th>lap</th><th class="r">avg rpm</th><th class="r">max rpm</th>
      <th class="r">shifts</th><th class="r">lat g</th><th class="r">acc g</th><th class="r">brk g</th>
      <th class="r">throttle</th><th class="r">power-ltd</th><th class="r">corner-ltd</th><th>gear usage</th></tr></thead><tbody>
      ${telemetryTable("Autocross (flat-out)", best.events.autocross.telemetry)}
      ${telemetryTable("Endurance (race pace)", best.events.endurance.telemetry)}
    </tbody></table>
    <p class="muted">"power-ltd" is the fraction of the lap where engine torque (not grip or cornering) bounds the car —
    the region where engine work buys lap time.</p>`;
  return `
    <p><strong>${esc(studyLabel(best.source))}</strong> — ${esc(best.vehicle.name)} · ${n(best.vehicle.massKg, 0)} kg ·
      FD ${n(best.vehicle.finalDrive, 2)} · accel ${n(accel.timeS, 3)} s</p>
    ${eventsTable(best.events)}
    ${fig(svgXYChart({
      width: 720, height: 260,
      series: [
        { label: "envelope (N)", xs: tr.speedsMps.map((v) => v * 3.6), y: tr.envelopeForce, color: INK },
        { label: "traction limit", xs: tr.speedsMps.map((v) => v * 3.6), y: tr.tractionLimit, color: PALETTE[3]! },
        { label: "drag + roll", xs: tr.speedsMps.map((v) => v * 3.6), y: tr.resistance, color: PALETTE[7]! },
      ],
      xLabel: "speed (km/h)", yLabel: "force (N)",
    }), "Tractive effort — per-gear envelope, tire-traction limit, drag + rolling resistance.")}
    <h3>Lap telemetry</h3>
    ${tel}`;
}

// --- lap-sim deep-dive --------------------------------------------------------
// Mirrors the Lap Sim screen for the report: the SAME physics chain
// (autocrossLapOpts/enduranceLapOpts + channels) so the document can never
// disagree with the app's traces.

const LIMIT_INFO: { state: LimitState; label: string; color: string }[] = [
  { state: "power", label: "power-limited", color: "#B8860B" },
  { state: "grip", label: "traction-limited", color: "#C0392B" },
  { state: "corner", label: "cornering ceiling", color: "#2E86C1" },
  { state: "brake", label: "braking", color: "#8E44AD" },
  { state: "coast", label: "coast", color: "#95A5A6" },
];

/** Time-weighted fraction of the lap in each limit state (same accounting as
 *  the Lap Sim screen's strip). */
function limitFractions(ch: LapChannels): Map<LimitState, number> {
  const acc = new Map<LimitState, number>();
  let total = 0;
  for (let i = 0; i < ch.tS.length; i++) {
    const dt = ch.tS[i]! - (i > 0 ? ch.tS[i - 1]! : 0);
    acc.set(ch.limit[i]!, (acc.get(ch.limit[i]!) ?? 0) + dt);
    total += dt;
  }
  if (total > 0) for (const [k, v] of acc) acc.set(k, v / total);
  return acc;
}

/** Speed-vs-distance trace with a limit-state strip underneath — the report's
 *  version of the Lap Sim screen's headline view. */
function svgSpeedWithLimits(ch: LapChannels, width: number, height: number): string {
  const padL = 52, padR = 12, padT = 14, padB = 56;
  const stripH = 12;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const xMax = ch.distM[ch.distM.length - 1]! || 1;
  const vKph = ch.vMps.map((v) => v * 3.6);
  const yMax = Math.max(...vKph) * 1.05 || 1;
  const X = (d: number) => padL + (plotW * d) / xMax;
  const Y = (v: number) => padT + plotH * (1 - v / yMax);
  const pts = ch.distM.map((d, i) => `${X(d).toFixed(1)},${Y(vKph[i]!).toFixed(1)}`).join(" ");
  // Limit strip: merge consecutive samples of the same state into one rect.
  const rects: string[] = [];
  const stripY = padT + plotH + 6;
  let runStart = 0;
  for (let i = 1; i <= ch.limit.length; i++) {
    if (i === ch.limit.length || ch.limit[i] !== ch.limit[runStart]) {
      const color = LIMIT_INFO.find((l) => l.state === ch.limit[runStart])?.color ?? "#999";
      const x0 = X(ch.distM[runStart]!);
      const x1 = X(i < ch.distM.length ? ch.distM[i]! : xMax);
      rects.push(`<rect x="${x0.toFixed(1)}" y="${stripY}" width="${Math.max(0.5, x1 - x0).toFixed(1)}" height="${stripH}" fill="${color}"/>`);
      runStart = i;
    }
  }
  const ticks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const ty = padT + (plotH * i) / 4;
    const yv = yMax - (yMax * i) / 4;
    ticks.push(`<line x1="${padL}" y1="${ty.toFixed(1)}" x2="${padL + plotW}" y2="${ty.toFixed(1)}" stroke="${i === 4 ? GRID : "#EDF0F3"}"/>`);
    ticks.push(`<text x="${padL - 6}" y="${(ty + 3).toFixed(1)}" font-size="8.5" fill="${MUTED}" text-anchor="end">${n(yv, 0)}</text>`);
    const tx = padL + (plotW * i) / 4;
    ticks.push(`<text x="${tx.toFixed(1)}" y="${stripY + stripH + 12}" font-size="8.5" fill="${MUTED}" text-anchor="middle">${n((xMax * i) / 4, 0)}</text>`);
  }
  const legend = LIMIT_INFO.map((l, i) =>
    `<rect x="${padL + i * 118}" y="${height - 11}" width="9" height="9" fill="${l.color}"/>
     <text x="${padL + i * 118 + 13}" y="${height - 3}" font-size="8.5" fill="${INK}">${esc(l.label)}</text>`).join("");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#FFFFFF"/>
    ${ticks.join("")}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${MUTED}" stroke-width="0.8"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="${MUTED}" stroke-width="0.8"/>
    <text x="12" y="${padT + plotH / 2}" font-size="10" fill="${INK}" text-anchor="middle" font-weight="600" transform="rotate(-90 12 ${padT + plotH / 2})">speed (km/h)</text>
    <polyline points="${pts}" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>
    ${rects.join("")}
    ${legend}
  </svg>`;
}

/** g-g diagram (lat vs long acceleration scatter) colored by limit state.
 *  Lateral sign comes from the traced layout's curvature (cornerSignsAtFracs)
 *  so left and right corners land on their real sides. */
function svgGG(ch: LapChannels, size: number, signs: number[]): string {
  const pad = 30;
  const plot = size - 2 * pad;
  const gMax = Math.max(1, ...ch.latG, ...ch.longG.map(Math.abs)) * 1.1;
  const X = (g: number) => pad + (plot * (g + gMax)) / (2 * gMax);
  const Y = (g: number) => pad + plot * (1 - (g + gMax) / (2 * gMax));
  const dots = ch.latG.map((lat, i) => {
    const color = LIMIT_INFO.find((l) => l.state === ch.limit[i])?.color ?? "#999";
    const sx = lat * (signs[i] || 1);
    return `<circle cx="${X(sx).toFixed(1)}" cy="${Y(ch.longG[i]!).toFixed(1)}" r="1.3" fill="${color}" fill-opacity="0.55"/>`;
  }).join("");
  const axis = `
    <line x1="${pad}" y1="${Y(0)}" x2="${pad + plot}" y2="${Y(0)}" stroke="${GRID}"/>
    <line x1="${X(0)}" y1="${pad}" x2="${X(0)}" y2="${pad + plot}" stroke="${GRID}"/>
    <text x="${pad + plot}" y="${Y(0) - 4}" font-size="8.5" fill="${MUTED}" text-anchor="end">lat g</text>
    <text x="${X(0) + 4}" y="${pad + 8}" font-size="8.5" fill="${MUTED}">long g</text>
    <text x="${pad - 2}" y="${Y(0) - 4}" font-size="8.5" fill="${MUTED}">−${n(gMax, 1)}</text>
    <text x="${X(0) + 4}" y="${pad + plot - 2}" font-size="8.5" fill="${MUTED}">−${n(gMax, 1)}</text>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" fill="#FFFFFF"/>${axis}${dots}</svg>`;
}

function lapSimSection(scored: Scored[]): string {
  const withPts = scored.filter((s) => s.events.totalPoints != null);
  const best = withPts.length
    ? withPts.reduce((a, b) => ((b.events.totalPoints as number) > (a.events.totalPoints as number) ? b : a))
    : scored[0];
  if (!best) return `<p class="muted">No scorable design.</p>`;
  const curve = torqueCurveFromSweep(best.source.points);
  const fuelMap = fuelMapFromSweep(best.source.points) ?? undefined;
  const runs: { label: string; lap: LapResult; ch: LapChannels }[] = [];
  for (const ev of [
    { label: "Autocross (flat-out)", track: AUTOCROSS_2026, opts: autocrossLapOpts() },
    { label: "Endurance (race pace)", track: ENDURANCE_2026, opts: enduranceLapOpts() },
  ]) {
    const lap = simLap(curve, best.vehicle, ev.track, { ...ev.opts, fuelMap, channels: true });
    if (lap.channels) runs.push({ label: ev.label, lap, ch: lap.channels });
  }
  if (runs.length === 0) return `<p class="muted">No lap channels available.</p>`;

  const fracRows = runs.map(({ label, lap, ch }) => {
    const fr = limitFractions(ch);
    const cells = LIMIT_INFO.map((l) => `<td class="r">${pct(fr.get(l.state) ?? 0)}</td>`).join("");
    const t = lap.telemetry;
    const bal = t.balanceMargin != null
      ? `${t.balanceMargin >= 0 ? "loose" : "push"} ${n(Math.abs(t.balanceMargin) * 100, 1)}%`
      : "—";
    return `<tr><td>${esc(label)}</td><td class="r">${n(lap.lapTimeS, 2)}</td>${cells}
      <td class="r">${n(t.vMaxKph, 0)} / ${n(t.vMinKph, 0)}</td><td class="r">${bal}</td></tr>`;
  }).join("");

  // Duty metrics (roadmap #11): what the lap costs the OTHER subteams.
  const dutyRows = runs.map(({ label, lap }) => {
    const t = lap.telemetry;
    return `<tr><td>${esc(label)}</td><td class="r">${n(t.brakeEnergyKJ, 0)}</td>
      <td class="r">${n(t.peakBrakePowerKw, 0)}</td><td class="r">${n(t.tireDutyGkm, 2)}</td>
      <td class="r">${n(lap.fuelKg * 1000, 0)}</td></tr>`;
  }).join("");

  // Corner-complex sectors (roadmap #10) for the flat-out autocross lap.
  const secs = lapSectors(runs[0]!.ch);
  const sectorRows = secs.map((s) => {
    const domColor = LIMIT_INFO.find((l) => l.state === s.dominant)?.color ?? MUTED;
    return `<tr><td>S${s.idx}</td><td class="r">${n(s.startM, 0)}–${n(s.endM, 0)}</td>
      <td class="r">${n(s.timeS, 2)}</td><td class="r">${n(s.vMinKph, 0)}</td><td class="r">${n(s.vMaxKph, 0)}</td>
      <td><span style="color:${domColor}">■</span> ${esc(LIMIT_INFO.find((l) => l.state === s.dominant)?.label ?? s.dominant)}</td></tr>`;
  }).join("");
  const sectorBlock = secs.length > 1 ? `
    <h3>Autocross sectors — corner complexes (split at brake applications)</h3>
    <table class="data"><thead><tr><th>sector</th><th class="r">from–to (m)</th><th class="r">time (s)</th>
      <th class="r">v min</th><th class="r">v max</th><th>limited by</th></tr></thead><tbody>${sectorRows}</tbody></table>` : "";

  const figs = runs.map(({ label, lap, ch }) =>
    fig(svgSpeedWithLimits(ch, 720, 240), `${label} — speed vs distance with the binding limit state along the lap (${n(lap.lapTimeS, 2)} s).`),
  ).join("");
  const axRun = runs[0]!;
  const axTotal = axRun.ch.distM[axRun.ch.distM.length - 1] || 1;
  const ggSigns = cornerSignsAtFracs(
    AUTOCROSS_2026_VISUAL.centerline,
    axRun.ch.distM.map((d) => d / axTotal),
  );
  const gg = fig(svgGG(axRun.ch, 280, ggSigns), "g-g diagram (autocross), colored by limit state — the friction-circle envelope the QSS solver actually used.");

  const sp = predictSkidpad(best.vehicle);
  return `
    <p><strong>${esc(studyLabel(best.source))}</strong> — the report re-runs the scoring laps with channel traces
    enabled (identical physics; channels are pure observation).</p>
    ${figs}
    <table class="data"><thead><tr><th>lap</th><th class="r">time (s)</th>
      ${LIMIT_INFO.map((l) => `<th class="r">${esc(l.label)}</th>`).join("")}
      <th class="r">v max/min (km/h)</th><th class="r">balance</th></tr></thead>
      <tbody>${fracRows}</tbody></table>
    <p class="muted">Fractions are time-weighted. "power-limited" is where engine torque directly buys lap time;
    "cornering ceiling" + "traction-limited" are chassis/tire territory. Balance is the time-weighted axle-capacity
    margin over corner-limited running (roll model).</p>
    <h3>Lap duty — what the lap costs the other subteams</h3>
    <table class="data"><thead><tr><th>lap</th><th class="r">brake energy (kJ)</th>
      <th class="r">peak brake power (kW)</th><th class="r">tire duty (g·km)</th><th class="r">fuel (g)</th></tr></thead>
      <tbody>${dutyRows}</tbody></table>
    <p class="muted">Brake energy is what the rotors absorb after drag's share (sizing input); tire duty is
    ∫|a_lat|·v dt — a relative cornering-work comparator for endurance tire degradation.</p>
    ${sectorBlock}
    <div class="two">${gg}
    <figure><table class="data"><thead><tr><th colspan="2">Grip-model validation — skidpad</th></tr></thead><tbody>
      <tr><td>Predicted time (9.125 m path)</td><td class="r">${n(sp.timeS, 2)} s</td></tr>
      <tr><td>Predicted speed</td><td class="r">${n(sp.speedKph, 1)} km/h</td></tr>
      <tr><td>Predicted lateral g</td><td class="r">${n(sp.latG, 2)} g</td></tr>
    </tbody></table>
    <figcaption>Skidpad isolates lateral grip (no aero, no line freedom, no engine) — the cleanest validation the
    rules offer. Real anchors: SDM26 5.02 s, SDM25 4.98 s.</figcaption></figure></div>`;
}

function comparisonSection(scored: Scored[]): string {
  if (scored.length < 2) return `<p class="muted">Fewer than two designs — nothing to compare.</p>`;
  const series: XYSeries[] = scored.map((s, i) => {
    const curve = torqueCurveFromSweep(s.source.points);
    return { label: studyLabel(s.source), xs: curve.map((p) => p.rpm), y: curve.map((p) => p.torqueNm), color: PALETTE[i % PALETTE.length]! };
  });
  const ref = scored[0]!;
  const rows = scored.map((s, i) => {
    const d = (get: (e: EventScores) => number | null) => {
      const a = get(ref.events); const b = get(s.events);
      return i === 0 || a == null || b == null ? null : b - a;
    };
    const f = (v: number | null, dec = 2, invert = false) =>
      v == null ? "" : ` <span class="${(invert ? -v : v) >= 0 ? "good" : "bad"}">(${v >= 0 ? "+" : ""}${v.toFixed(dec)})</span>`;
    return `<tr><td><span style="color:${PALETTE[i % PALETTE.length]}">■</span> ${esc(studyLabel(s.source))}</td>
      <td class="r">${n(s.events.autocross.lapTimeS, 2)}${f(d((e) => e.autocross.lapTimeS), 2, true)}</td>
      <td class="r">${n(s.events.endurance.lapTimeS, 2)}${f(d((e) => e.endurance.lapTimeS), 2, true)}</td>
      <td class="r">${n(s.events.totalPoints)}${f(d((e) => e.totalPoints), 1)}</td></tr>`;
  }).join("");
  return `
    ${fig(svgXYChart({ width: 720, height: 280, series, xLabel: "rpm", yLabel: "brake torque (Nm)" }), "Torque curves of every completed design, overlaid.")}
    <table class="data"><thead><tr><th>design</th><th class="r">AX (s)</th><th class="r">EN (s/lap)</th><th class="r">total pts</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted">Deltas are vs the first row; green = better (lower time / more points).</p>`;
}

function registrySection(studies: Study[]): string {
  const rows = studies.map((s) => `<tr><td>${esc(studyName(s))}</td><td>${esc(s.kind)}</td>
    <td class="muted">${esc(s.configPath)}</td><td>${esc(new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 16))}</td>
    <td>${esc(s.status)}</td><td class="muted">${esc(s.id)}</td></tr>`).join("");
  return `<table class="data"><thead><tr><th>name</th><th>kind</th><th>config</th><th>started (UTC)</th><th>status</th><th>id</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// --- assembly ----------------------------------------------------------------

export function buildMasterReportHtml(input: MasterReportInput): string {
  const all = Object.values(input.studies).sort((a, b) => a.startedAt - b.startedAt);
  const studies = input.only ? all.filter((s) => input.only!.includes(s.id)) : all;
  const scopedRecord = Object.fromEntries(studies.map((s) => [s.id, s]));
  const sources = sourcesFrom(scopedRecord);
  const scored = scoreSources(sources, input.vehicleConfig, input.referenceBaseline);
  const sweeps = studies.filter((s): s is SweepStudy => s.kind === "sweep" && s.points.length > 0);
  const optimizations = studies.filter((s): s is OptimizationStudy => s.kind === "optimization");

  const sections: { title: string; html: string }[] = [
    { title: "Executive summary", html: executiveSummary(scored) },
    { title: "Methodology & calibration", html: methodology(input.referenceBaseline) },
  ];
  if (!input.only || scored.length >= 2) sections.push({ title: "Design comparison", html: comparisonSection(scored) });
  sweeps.forEach((s) => sections.push({
    title: `Sweep — ${studyName(s)}`,
    html: sweepSection(s, input.vehicleConfig, input.referenceBaseline),
  }));
  optimizations.forEach((s) => sections.push({
    title: `Optimization — ${studyName(s)}`,
    html: optimizationSection(s),
  }));
  if (scored.length > 0) sections.push({ title: "Best design — FSAE deep-dive", html: bestDesignSection(scored) });
  if (scored.length > 0) sections.push({ title: "Lap simulation — traces & limit states", html: lapSimSection(scored) });
  sections.push({
    title: "Competition courses (2026)",
    html: `<div class="two">
      ${fig(svgVisualTrack(AUTOCROSS_2026_VISUAL, 350, 220), `${AUTOCROSS_2026_VISUAL.name} — traced layout, centerline colored by corner tightness.`)}
      ${fig(svgVisualTrack(ENDURANCE_2026_VISUAL, 350, 220), `${ENDURANCE_2026_VISUAL.name} — traced layout (closed loop).`)}
    </div>`,
  });
  sections.push({ title: "Appendix — study registry", html: registrySection(studies) });

  const date = esc(input.generatedAt.slice(0, 10));
  const title = input.title ?? (input.only && studies.length === 1 && studies[0] ? `Study report — ${studyName(studies[0])}` : "Helios CFD — Engineering Report");
  const toc = sections.map((s, i) => `<li><a href="#sec-${i + 1}">${i + 1}. ${esc(s.title)}</a></li>`).join("");
  const body = sections.map((s, i) => `
    <section class="rsec" id="sec-${i + 1}">
      <h2><span class="secno">${i + 1}</span> ${esc(s.title)}</h2>
      ${s.html}
    </section>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 34px 42px; font: 13px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; color: ${INK}; background: #fff; }
  h1 { font-size: 26px; letter-spacing: -0.01em; margin: 0 0 4px; }
  h2 { display: flex; align-items: baseline; gap: 10px; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; color: ${INK}; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 2px solid ${ACCENT}; }
  h2 .secno { color: ${ACCENT}; font-weight: 700; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: ${MUTED}; margin: 16px 0 6px; }
  .sub { color: ${MUTED}; font-size: 11px; margin: 0 0 4px; }
  .cover { padding: 22px 26px; margin: 0 0 18px; border: 1px solid ${GRID}; border-top: 6px solid ${ACCENT}; border-radius: 6px; background: linear-gradient(180deg, #FCFCFD, #FFFFFF); }
  .cover .meta { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 10px; }
  .cover .meta div { font-size: 11px; }
  .cover .meta .k { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: ${MUTED}; }
  nav.toc { border: 1px solid ${GRID}; border-radius: 6px; padding: 12px 18px; margin-bottom: 8px; }
  nav.toc h2 { border: none; margin: 0 0 4px; padding: 0; }
  nav.toc ol { margin: 6px 0; padding-left: 22px; font-size: 12px; columns: 2; column-gap: 36px; }
  nav.toc li { margin: 2px 0; }
  nav.toc a { color: ${INK}; text-decoration: none; }
  nav.toc a:hover { color: ${ACCENT}; }
  section.rsec { margin-top: 26px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 4px 0 14px; }
  .card { border: 1px solid ${GRID}; border-left: 3px solid ${ACCENT}; border-radius: 4px; padding: 8px 10px; }
  .card .k { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: ${MUTED}; }
  .card .v { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  table.data { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; margin: 6px 0 10px; }
  table.data th, table.data td { text-align: left; padding: 6px 9px; font-size: 11.5px; }
  table.data thead th { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: #FFFFFF; background: ${INK}; }
  table.data thead th:first-child { border-radius: 3px 0 0 0; } table.data thead th:last-child { border-radius: 0 3px 0 0; }
  table.data tbody tr { border-bottom: 1px solid #EDF0F3; }
  table.data tbody tr:nth-child(even) { background: #F8F9FB; }
  .r { text-align: right; } .muted { color: ${MUTED}; } .accent { color: ${ACCENT}; font-weight: 600; }
  .good { color: #1E8449; } .bad { color: #C0392B; font-weight: 600; }
  tr.total td { border-top: 2px solid ${INK}; font-weight: 600; background: #FFF9E8; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  figure { margin: 12px 0; border: 1px solid ${GRID}; border-radius: 6px; padding: 8px; background: #FFFFFF; }
  figure svg { display: block; max-width: 100%; height: auto; }
  figcaption { font-size: 10px; font-style: italic; color: ${MUTED}; margin-top: 6px; padding-top: 5px; border-top: 1px solid #F0F2F4; }
  footer { margin-top: 30px; font-size: 10px; color: ${MUTED}; border-top: 2px solid ${ACCENT}; padding-top: 8px; display: flex; justify-content: space-between; gap: 16px; }
  @media print {
    body { padding: 0; }
    section.rsec { break-before: page; padding-top: 6px; }
    section.rsec:first-of-type { break-before: auto; }
    h2, h3 { break-after: avoid; }
    figure, table, .cards { break-inside: avoid; }
    nav.toc { break-after: page; }
    nav.toc ol { columns: 1; }
  }
</style></head>
<body>
  <div class="cover">
    <h1>${esc(title)}</h1>
    <p class="sub">FSAE engine &amp; vehicle performance analysis — Helios CFD module</p>
    <div class="meta">
      <div><span class="k">Generated</span>${date}</div>
      <div><span class="k">Studies</span>${studies.length}</div>
      <div><span class="k">Scored designs</span>${scored.length}</div>
      <div><span class="k">Scoring reference</span>${input.referenceBaseline.enduranceTMin ? "2026 field anchors" : "configured baseline"}</div>
    </div>
  </div>
  <nav class="toc"><h2>Contents</h2><ol>${toc}</ol></nav>
  ${body}
  <footer><span>Projected FSAE points use frontend scoring against the configured field anchors. All curves and
  scores were recomputed through the same production code paths as the application screens at generation time.</span>
  <span style="white-space:nowrap">${esc(title)} · ${date}</span></footer>
</body></html>`;
}
