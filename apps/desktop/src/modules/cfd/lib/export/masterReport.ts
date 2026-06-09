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
  tractiveMap,
  AUTOCROSS_2026_VISUAL,
  ENDURANCE_2026_VISUAL,
  type EventScores,
  type LapTelemetry,
} from "../performance";
import { sourcesFrom, type CurveSource } from "../curveSources";
import { studyName } from "../studyName";
import { rankTrials, sensitivityTornado } from "../analytics/optimizationStats";
import { compareDyno } from "../analytics/dynoCompare";
import { dynoPowerKw } from "../import/importDyno";
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
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.8"${dash}/>`;
  }).join("");
  const legend = series.map((s, i) =>
    `<text x="${padL + 6}" y="${padT + 11 + i * 12}" font-size="9" fill="${s.color}">${s.dashed ? "▪▪" : "■"} ${esc(s.label)}</text>`,
  ).join("");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#FFFFFF"/>
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
  return `<table class="data"><thead><tr><th>Design</th><th class="r">peak τ</th><th class="r">accel (s)</th>
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
    const cmp = compareDyno(points.map((p) => ({ rpm: p.rpm, powerKw: p.lastCycle.brakePowerKW })), study.dynoRef.points);
    dynoBlock = cmp
      ? `<p><strong>Dyno validation:</strong> RMSE ${n(cmp.rmseKw, 2)} kW, bias ${cmp.biasKw >= 0 ? "+" : ""}${n(cmp.biasKw, 2)} kW
         (sim − dyno) over ${cmp.n} points, ${n(cmp.rpmMin, 0)}–${n(cmp.rpmMax, 0)} rpm.</p>`
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
  const done = study.trials.filter((t) => t.status === "done" && t.objectiveValue != null);
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
      <h2>${i + 1}. ${esc(s.title)}</h2>
      ${s.html}
    </section>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 36px; font: 13px/1.45 -apple-system, Segoe UI, Roboto, sans-serif; color: ${INK}; background: #fff; }
  h1 { font-size: 24px; margin: 0 0 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: ${ACCENT}; margin: 26px 0 10px; border-bottom: 1px solid ${GRID}; padding-bottom: 4px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: ${MUTED}; margin: 14px 0 6px; }
  .sub { color: ${MUTED}; font-size: 11px; margin: 0 0 4px; }
  .cover { border-bottom: 3px solid ${ACCENT}; padding-bottom: 14px; margin-bottom: 14px; }
  nav.toc ol { margin: 6px 0; padding-left: 20px; font-size: 12px; }
  nav.toc a { color: ${INK}; text-decoration: none; }
  table.data { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  table.data th, table.data td { text-align: left; padding: 5px 8px; border-bottom: 1px solid ${GRID}; font-size: 11.5px; }
  table.data th { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: ${MUTED}; }
  .r { text-align: right; } .muted { color: ${MUTED}; } .accent { color: ${ACCENT}; font-weight: 600; }
  .good { color: #1E8449; } .bad { color: #C0392B; }
  tr.total td { border-top: 2px solid ${GRID}; font-weight: 600; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  figure { margin: 10px 0; border: 1px solid ${GRID}; border-radius: 4px; padding: 6px; }
  figcaption { font-size: 10px; color: ${MUTED}; margin-top: 4px; }
  footer { margin-top: 26px; font-size: 10px; color: ${MUTED}; border-top: 1px solid ${GRID}; padding-top: 8px; }
  @media print {
    body { padding: 0; }
    section.rsec { break-before: page; }
    section.rsec:first-of-type { break-before: auto; }
    h2, h3 { break-after: avoid; }
    figure, table { break-inside: avoid; }
    nav.toc { break-after: page; }
  }
</style></head>
<body>
  <div class="cover">
    <h1>${esc(title)}</h1>
    <p class="sub">Generated ${date} · ${studies.length} stud${studies.length === 1 ? "y" : "ies"} ·
      ${scored.length} scored design${scored.length === 1 ? "" : "s"} · Helios CFD module</p>
  </div>
  <nav class="toc"><h2>Contents</h2><ol>${toc}</ol></nav>
  ${body}
  <footer>Projected FSAE points use frontend scoring against the configured field anchors. All curves and
  scores in this document were recomputed through the same production code paths as the application screens
  at generation time. Print this document to PDF for distribution.</footer>
</body></html>`;
}
