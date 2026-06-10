// Lap Sim screen: the full 2D lap-sim workbench. Runs the SAME physics as the
// FSAE event scoring (autocrossLapOpts/enduranceLapOpts — single source) but
// with channel traces enabled, then turns them into the race-engineer toolkit:
// channel-colored track map, speed/RPM/gear traces, g-g diagram, limit-state
// breakdown (where the ENGINE is the binding constraint), A/B comparison with
// a cumulative delta-time trace, and a MoTeC-style CSV export for hand-off.

import { useEffect, useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { ReportButton } from "../components/ReportButton";
import { LinePlot } from "../components/charts/LinePlot";
import { ChannelTrackMap } from "../components/charts/ChannelTrackMap";
import { MiniHistogram, type HistSeries } from "../components/charts/MiniHistogram";
import { GGDiagram, LIMIT_COLOR } from "../components/charts/GGDiagram";
import { sourcesFrom, type CurveSource } from "../lib/curveSources";
import { rampColor, rampColors } from "../lib/colorScale";
import { buildLapChannelsCsv } from "../lib/export/lapChannelsCsv";
import { saveTextFile, fileTimestamp, slugify } from "../lib/export/io";
import {
  carKeyForConfig,
  vehicleForCar,
  torqueCurveFromSweep,
  simLap,
  autocrossLapOpts,
  enduranceLapOpts,
  AUTOCROSS_2026,
  ENDURANCE_2026,
  AUTOCROSS_2026_VISUAL,
  ENDURANCE_2026_VISUAL,
  type LapResult,
  type LapChannels,
  type LimitState,
  type VehicleConfig,
} from "../lib/performance";

type EventKey = "autocross" | "endurance";

const EVENTS: { key: EventKey; label: string; note: string }[] = [
  { key: "autocross", label: "Autocross", note: "flat-out" },
  { key: "endurance", label: "Endurance", note: "race pace" },
];

type ChannelKey = "speed" | "rpm" | "gear" | "latG" | "longG" | "limit" | "fuel";

const CHANNELS: { key: ChannelKey; label: string; unit: string; get: (ch: LapChannels, i: number) => number }[] = [
  { key: "speed", label: "speed", unit: "km/h", get: (ch, i) => ch.vMps[i]! * 3.6 },
  { key: "rpm", label: "rpm", unit: "rpm", get: (ch, i) => ch.rpm[i]! },
  { key: "gear", label: "gear", unit: "", get: (ch, i) => ch.gear[i]! },
  { key: "latG", label: "lat g", unit: "g", get: (ch, i) => ch.latG[i]! },
  { key: "longG", label: "long g", unit: "g", get: (ch, i) => ch.longG[i]! },
  { key: "limit", label: "limit state", unit: "", get: (ch, i) => ch.gear[i]! /* unused (categorical) */ },
  { key: "fuel", label: "fuel burned", unit: "g", get: (ch, i) => ch.fuelCumKg[i]! * 1000 },
];

interface LapRun {
  source: CurveSource;
  vehicle: VehicleConfig;
  lap: LapResult;
  ch: LapChannels;
}

/** Time-weighted fraction of the lap in each limit state. */
function limitFractions(ch: LapChannels): { state: LimitState; frac: number }[] {
  const acc: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i < ch.tS.length; i++) {
    const dt = ch.tS[i]! - (i > 0 ? ch.tS[i - 1]! : 0);
    acc[ch.limit[i]!] = (acc[ch.limit[i]!] ?? 0) + dt;
    total += dt;
  }
  const order: LimitState[] = ["power", "grip", "corner", "brake", "coast"];
  return order
    .map((state) => ({ state, frac: total > 0 ? (acc[state] ?? 0) / total : 0 }))
    .filter((e) => e.frac > 0.001);
}

/** Linear interpolation of y(x) sampled at ascending xs, clamped at the ends. */
function interpAt(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]!) / Math.max(1e-12, xs[hi]! - xs[lo]!);
  return ys[lo]! + f * (ys[hi]! - ys[lo]!);
}

export function LapSimScreen() {
  const { state, navigateTo } = useCfd();
  const sources = useMemo(() => sourcesFrom(state.studies), [state.studies]);

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [event, setEvent] = useState<EventKey>("autocross");
  const [channel, setChannel] = useState<ChannelKey>("speed");
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const sourceA = sources.find((s) => s.id === sourceId) ?? sources[0] ?? null;
  const sourceB = sources.find((s) => s.id === compareId && s.id !== sourceA?.id) ?? null;

  const track = event === "autocross" ? AUTOCROSS_2026 : ENDURANCE_2026;
  const visual = event === "autocross" ? AUTOCROSS_2026_VISUAL : ENDURANCE_2026_VISUAL;

  const runFor = (src: CurveSource | null): LapRun | null => {
    if (!src) return null;
    const curve = torqueCurveFromSweep(src.points);
    if (curve.length === 0) return null;
    const vehicle = vehicleForCar(carKeyForConfig(src.configName), state.vehicleConfig);
    const opts = event === "autocross" ? autocrossLapOpts() : enduranceLapOpts();
    const lap = simLap(curve, vehicle, track, { ...opts, channels: true });
    return lap.channels ? { source: src, vehicle, lap, ch: lap.channels } : null;
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runA = useMemo(() => runFor(sourceA), [sourceA, event, state.vehicleConfig]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runB = useMemo(() => runFor(sourceB), [sourceB, event, state.vehicleConfig]);

  // Cumulative time delta B−A on A's distance grid (positive = A ahead).
  const deltaT = useMemo(() => {
    if (!runA || !runB) return null;
    return runA.ch.distM.map((d, i) => interpAt(runB.ch.distM, runB.ch.tS, d) - runA.ch.tS[i]!);
  }, [runA, runB]);

  // Track-map coloring for the selected channel.
  const mapData = useMemo(() => {
    if (!runA) return null;
    const ch = runA.ch;
    const total = ch.distM[ch.distM.length - 1] || 1;
    const fracs = ch.distM.map((d) => d / total);
    if (channel === "limit") {
      return { fracs, colors: ch.limit.map((l) => LIMIT_COLOR[l]), min: null, max: null };
    }
    const def = CHANNELS.find((c) => c.key === channel)!;
    const values = ch.distM.map((_, i) => def.get(ch, i));
    const { colors, min, max } = rampColors(values);
    return { fracs, colors, min, max };
  }, [runA, channel]);

  async function exportCsv() {
    if (!runA) return;
    try {
      const csv = buildLapChannelsCsv(
        {
          configName: runA.source.configName,
          vehicleName: runA.vehicle.name,
          event,
          trackName: track.name,
          generatedAt: new Date().toISOString(),
        },
        runA.lap,
      );
      const stem = `cfd-lapsim-${event}-${slugify(runA.source.configName)}-${fileTimestamp()}`;
      const path = await saveTextFile(stem, "csv", csv);
      setExportMsg(path == null ? "Cancelled" : `Saved → ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setExportMsg(null), 4000);
  }

  const channelDef = CHANNELS.find((c) => c.key === channel)!;

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Lap Sim</div>
          <p className="text-[10px] text-[#5A5F66]">
            gear-explicit QSS · same physics as event scoring · {visual.name}
          </p>
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {/* Event toggle */}
          <div className="flex overflow-hidden rounded-sm border border-[#2A2C32]">
            {EVENTS.map((e) => (
              <button
                key={e.key}
                type="button"
                onClick={() => setEvent(e.key)}
                title={e.note}
                className={
                  "px-2.5 py-1 text-[10px] uppercase tracking-wider " +
                  (event === e.key ? "bg-[#FFC627] font-semibold text-[#0E0E10]" : "text-[#9097A0] hover:text-[#FFC627]")
                }
              >
                {e.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#9097A0]">
            A
            <select
              aria-label="Lap source A"
              className="max-w-[220px] rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
              value={sourceA?.id ?? ""}
              onChange={(e) => setSourceId(e.target.value)}
            >
              {sources.length === 0 && <option value="">(no studies)</option>}
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#9097A0]">
            vs
            <select
              aria-label="Lap source B (compare)"
              className="max-w-[220px] rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
              value={sourceB?.id ?? ""}
              onChange={(e) => setCompareId(e.target.value || null)}
            >
              <option value="">(none)</option>
              {sources.filter((s) => s.id !== sourceA?.id).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={!runA}
            title="Export every channel trace (distance, time, speed, rpm, gear, g's, limit state, fuel) as CSV"
            className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627] disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
              <ReportButton label="Full report (PDF)" />
      </header>

      {exportMsg && (
        <div role="status" className="flex-shrink-0 border-b border-[#FFC627]/40 bg-[#16171B] px-3 py-1 text-[10px] text-[#D8DCE2]">
          {exportMsg}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!runA ? (
          <div className="m-4 rounded-sm border border-dashed border-[#2A2C32] p-8 text-center text-[11px] text-[#5A5F66]">
            No torque curve available. Run a sweep or an optimization first — the lap sim
            drives the car with the engine from a completed study.
            <div className="mt-3">
              <button
                type="button"
                className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300"
                onClick={() => navigateTo("studies")}
              >
                Go to studies
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Headline stats (+ B row when comparing) */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <HeadlineRow tag="A" run={runA} accent />
              {runB && <HeadlineRow tag="B" run={runB} deltaVs={runA} />}
              <LimitBar run={runA} />
            </section>

            {/* Track map + g-g */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
              <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10] lg:col-span-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2A2C32] px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">
                    Track map — {visual.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="Map channel"
                      className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-0.5 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
                      value={channel}
                      onChange={(e) => setChannel(e.target.value as ChannelKey)}
                    >
                      {CHANNELS.map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </select>
                    {channel === "limit" ? (
                      <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-wider text-[#5A5F66]">
                        {(Object.keys(LIMIT_COLOR) as LimitState[]).map((s) => (
                          <span key={s} className="flex items-center gap-0.5">
                            <span className="inline-block h-1.5 w-2.5 rounded-sm" style={{ background: LIMIT_COLOR[s] }} />
                            {s}
                          </span>
                        ))}
                      </div>
                    ) : (
                      mapData?.min != null && (
                        <div className="flex items-center gap-1 text-[9px] font-mono text-[#5A5F66]">
                          <span>{mapData.min.toFixed(channel === "rpm" ? 0 : 1)}</span>
                          <span
                            className="inline-block h-2 w-16 rounded-sm"
                            style={{
                              background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map(rampColor).join(",")})`,
                            }}
                          />
                          <span>{mapData.max!.toFixed(channel === "rpm" ? 0 : 1)}</span>
                          <span className="text-[#5A5F66]">{channelDef.unit}</span>
                        </div>
                      )
                    )}
                  </div>
                </div>
                {mapData && (
                  <LapPlayer
                    runA={runA}
                    runB={runB}
                    visual={visual}
                    fracs={mapData.fracs}
                    colors={mapData.colors}
                  />
                )}
                <p className="px-3 pb-2 text-[9px] leading-tight text-[#5A5F66]">
                  Channel mapped onto the traced layout by lap-distance fraction (the sim integrates the radius profile).
                  ▶ races A (gold) and B (blue) in real lap time — B&apos;s dot shows true track position at the same instant.
                </p>
              </section>

              <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10] lg:col-span-2">
                <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">g-g diagram — A</span>
                  <span className="text-[9px] text-[#5A5F66]">dashed = static μ ellipse (aero adds the rest)</span>
                </div>
                <GGDiagram
                  latG={runA.ch.latG}
                  longG={runA.ch.longG}
                  limit={runA.ch.limit}
                  muLat={runA.vehicle.muLat}
                  muLong={runA.vehicle.muLong}
                  height={330}
                />
              </section>
            </div>

            {/* Delta-T (compare mode) */}
            {runB && deltaT && (
              <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <LinePlot
                  title={`Δ time (B − A) vs distance — +ve = A ahead · final ${deltaT[deltaT.length - 1]!.toFixed(2)} s`}
                  xs={runA.ch.distM}
                  series={[{ label: "ΔT (s)", y: deltaT, color: "#F48FB1", width: 2, showPoints: false }]}
                  xLabel="distance (m)"
                  yLabel="s"
                  height={220}
                />
                <p className="px-3 pb-2 text-[9px] leading-tight text-[#5A5F66]">
                  Upward slope = A gaining on B (corner exits, straights); steps = shift-time differences. The classic
                  overlay tool: find WHERE the lap time comes from, not just how much.
                </p>
              </section>
            )}

            {/* Channel traces */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <LinePlot
                title="speed & gear vs distance"
                xs={runA.ch.distM}
                series={[
                  { label: `A ${runA.vehicle.name} (km/h)`, y: runA.ch.vMps.map((v) => v * 3.6), color: "#FFC627", width: 2, showPoints: false },
                  ...(runB
                    ? [{ label: `B ${runB.vehicle.name} (km/h)`, y: runA.ch.distM.map((d) => interpAt(runB.ch.distM, runB.ch.vMps, d) * 3.6), color: "#4FC3F7", width: 1.5, showPoints: false }]
                    : []),
                  { label: "gear (A)", y: runA.ch.gear, color: "#5A5F66", axis: "y2" as const, width: 1, showPoints: false },
                ]}
                xLabel="distance (m)"
                yLabel="km/h"
                y2Label="gear"
                height={260}
              />
            </section>
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <LinePlot
                title="engine rpm vs distance"
                xs={runA.ch.distM}
                series={[
                  { label: `A ${runA.vehicle.name}`, y: runA.ch.rpm, color: "#FFC627", width: 1.5, showPoints: false },
                  ...(runB
                    ? [{ label: `B ${runB.vehicle.name}`, y: runA.ch.distM.map((d) => interpAt(runB.ch.distM, runB.ch.rpm, d)), color: "#4FC3F7", width: 1.5, showPoints: false }]
                    : []),
                ]}
                xLabel="distance (m)"
                yLabel="rpm"
                height={240}
              />
            </section>
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <LinePlot
                title="accelerations vs distance — A"
                xs={runA.ch.distM}
                series={[
                  { label: "lateral (g)", y: runA.ch.latG, color: "#4FC3F7", width: 1.5, showPoints: false },
                  { label: "longitudinal (g)", y: runA.ch.longG, color: "#FF8A65", width: 1.5, showPoints: false },
                ]}
                xLabel="distance (m)"
                yLabel="g"
                height={240}
              />
            </section>

            {/* Lap-time residency histograms — where the car/engine LIVES.
                RPM residency is the engine team's tuning target map; with a B
                lap the outline overlays it for direct comparison. */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">
                  Lap-time residency — fraction of lap time per bin{runB ? " (line = B)" : ""}
                </span>
                <span className="text-[9px] text-[#5A5F66]">
                  tune the engine where the RPM histogram lives, not at the peak
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-3">
                <MiniHistogram
                  title="engine rpm residency"
                  unit="rpm"
                  series={histSeries(runA, (ch, i) => ch.rpm[i]!, "A", "#FFC627")}
                  overlay={runB ? histSeries(runB, (ch, i) => ch.rpm[i]!, "B", "#4FC3F7") : undefined}
                />
                <MiniHistogram
                  title="speed residency"
                  unit="km/h"
                  series={histSeries(runA, (ch, i) => ch.vMps[i]! * 3.6, "A", "#FFC627")}
                  overlay={runB ? histSeries(runB, (ch, i) => ch.vMps[i]! * 3.6, "B", "#4FC3F7") : undefined}
                />
                <MiniHistogram
                  title="lateral g residency"
                  unit="g"
                  series={histSeries(runA, (ch, i) => Math.abs(ch.latG[i]!), "A", "#FFC627")}
                  overlay={runB ? histSeries(runB, (ch, i) => Math.abs(ch.latG[i]!), "B", "#4FC3F7") : undefined}
                />
              </div>
            </section>

            <ChannelAnalyzer runA={runA} runB={runB} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Lap player ---------------------------------------------------------------
// "Play" the simulated lap: car dots animate over the channel-colored map in
// real lap time (×speed), with every channel AND the engine's sweep-point
// internals (VE, EGT, knock integral, BMEP, power) interpolated smoothly at
// the cursor. Scrub with the slider; with a B lap, both dots race — B's
// position is its own distance at the SAME instant, so the gap is visible
// on track, not just in the ΔT chart.
function LapPlayer({
  runA, runB, visual, fracs, colors,
}: {
  runA: LapRun;
  runB: LapRun | null;
  visual: typeof AUTOCROSS_2026_VISUAL;
  fracs: number[];
  colors: string[];
}) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mult, setMult] = useState(1);
  const chA = runA.ch;
  const endT = chA.tS[chA.tS.length - 1] ?? 0;
  const totalDist = chA.distM[chA.distM.length - 1] || 1;

  // Reset the cursor when the lap changes (new source/event/vehicle).
  useEffect(() => setT(0), [runA]);

  useEffect(() => {
    if (!playing || endT <= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * mult;
      last = now;
      setT((prev) => (prev + dt >= endT ? prev + dt - endT : prev + dt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, mult, endT]);

  // Smoothly interpolated cursor state (categorical channels use nearest).
  const cur = useMemo(() => {
    const dist = interpAt(chA.tS, chA.distM, t);
    const rpm = interpAt(chA.tS, chA.rpm, t);
    // nearest sample for the categorical channels
    let i = 0;
    let lo = 0;
    let hi = chA.tS.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (chA.tS[mid]! <= t) lo = mid;
      else hi = mid;
    }
    i = t - chA.tS[lo]! < chA.tS[hi]! - t ? lo : hi;
    // engine internals at the cursor's rpm, from the source sweep points
    const pts = [...runA.source.points].sort((a, b) => a.rpm - b.rpm);
    const rpms = pts.map((p) => p.rpm);
    const eng = (get: (p: (typeof pts)[number]) => number | undefined): number =>
      interpAt(rpms, pts.map((p) => get(p) ?? NaN), rpm);
    return {
      dist,
      frac: dist / totalDist,
      speedKph: interpAt(chA.tS, chA.vMps, t) * 3.6,
      rpm,
      gear: chA.gear[i] ?? 0,
      latG: interpAt(chA.tS, chA.latG, t),
      longG: interpAt(chA.tS, chA.longG, t),
      limit: chA.limit[i] ?? "coast",
      fuelG: interpAt(chA.tS, chA.fuelCumKg, t) * 1000,
      powerKw: eng((p) => p.lastCycle.brakePowerKW),
      ve: eng((p) => p.lastCycle.veAtm),
      egt: eng((p) => p.lastCycle.egtMean),
      ki: eng((p) => p.lastCycle.knockIntegral),
      bmep: eng((p) => p.lastCycle.bmepBar),
    };
  }, [chA, t, totalDist, runA.source.points]);

  // B's true position at the same instant (clamped to its own finish).
  const fracB = useMemo(() => {
    if (!runB) return null;
    const chB = runB.ch;
    const dB = interpAt(chB.tS, chB.distM, Math.min(t, chB.tS[chB.tS.length - 1] ?? 0));
    return dB / (chB.distM[chB.distM.length - 1] || 1);
  }, [runB, t]);

  const markers = [
    { frac: cur.frac, color: "#FFC627", label: "A" },
    ...(fracB != null ? [{ frac: fracB, color: "#4FC3F7", label: "B" }] : []),
  ];

  return (
    <div>
      <ChannelTrackMap track={visual} fracs={fracs} colors={colors} height={330} markers={markers} />
      {/* Transport */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[#2A2C32] px-3 py-1.5">
        <button
          type="button"
          aria-label={playing ? "Pause lap playback" : "Play lap playback"}
          onClick={() => setPlaying((p) => !p)}
          className="rounded-sm border border-[#FFC627]/50 px-2.5 py-0.5 font-mono text-[12px] text-[#FFC627] hover:bg-[#FFC627]/10"
        >
          {playing ? "⏸" : "▶"}
        </button>
        {[0.5, 1, 2, 4].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMult(m)}
            className={
              "rounded-sm px-1.5 py-0.5 font-mono text-[10px] " +
              (mult === m ? "bg-[#FFC627] text-[#0E0E10]" : "text-[#9097A0] hover:text-[#FFC627]")
            }
          >
            {m}×
          </button>
        ))}
        <input
          type="range"
          aria-label="Lap scrub"
          min={0}
          max={endT}
          step={endT / 2000}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setT(parseFloat(e.target.value));
          }}
          className="min-w-[120px] flex-1 accent-[#FFC627]"
        />
        <span className="font-mono text-[11px] tabular-nums text-[#D8DCE2]">
          {t.toFixed(2)} / {endT.toFixed(2)} s
        </span>
      </div>
      {/* Dash — supersport cluster: tach wrapping the top, gear box, digital
          speed, live g-dot, and engine mini-bars. */}
      <div className="flex flex-wrap items-end gap-4 border-t border-[#2A2C32] bg-[#0B0B0D] px-3 py-2">
        <Tachometer rpm={cur.rpm} revLimit={runA.vehicle.revLimitRpm} />
        <div
          className="flex flex-col items-center rounded-md border border-[#2A2C32] bg-[#101114] px-3 py-1.5"
          aria-label="Gear position"
          style={{ boxShadow: "inset 0 0 12px #00000088" }}
        >
          <span className="text-[7px] uppercase tracking-[0.2em] text-[#5A5F66]">gear</span>
          <span
            className="font-mono text-[46px] font-bold leading-none text-[#FFC627]"
            style={{ textShadow: "0 0 14px #FFC62766" }}
          >
            {cur.gear || "N"}
          </span>
        </div>
        <div className="flex flex-col items-center rounded-md border border-[#2A2C32] bg-[#101114] px-3 py-1.5"
          style={{ boxShadow: "inset 0 0 12px #00000088" }}>
          <span className="text-[7px] uppercase tracking-[0.2em] text-[#5A5F66]">speed · km/h</span>
          <span className="font-mono text-[38px] font-bold leading-none text-[#D8DCE2] tabular-nums"
            style={{ textShadow: "0 0 10px #D8DCE233" }}>
            {cur.speedKph.toFixed(0)}
          </span>
          <span
            className="mt-1 rounded-sm px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider"
            style={{
              color: LIMIT_COLOR[cur.limit],
              border: `1px solid ${LIMIT_COLOR[cur.limit]}66`,
              background: `${LIMIT_COLOR[cur.limit]}14`,
            }}
          >
            {cur.limit}
          </span>
        </div>
        <GDot latG={cur.latG} longG={cur.longG} />
        {/* Engine vitals as mini bar gauges */}
        <div className="grid min-w-[210px] flex-1 grid-cols-1 gap-1.5 sm:grid-cols-2">
          <BarGauge label="power" value={cur.powerKw} max={55} unit="kW" color="#FFC627" />
          <BarGauge label="BMEP" value={cur.bmep} max={13} unit="bar" color="#4FC3F7" />
          <BarGauge label="VE" value={cur.ve * 100} max={130} unit="%" color="#A5D6A7" />
          <BarGauge label="EGT" value={cur.egt} min={600} max={1300} unit="K" color="#FF8A65" />
          <BarGauge label="fuel" value={cur.fuelG} max={Math.max(1, runA.lap.fuelKg * 1000)} unit="g" color="#CE93D8" />
          <BarGauge label="dist" value={cur.dist} max={totalDist} unit="m" color="#9097A0" />
        </div>
      </div>
    </div>
  );
}

/** Compact horizontal bar gauge with value readout — engine-vitals style. */
function BarGauge({
  label, value, max, unit, color, min = 0,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  color: string;
  min?: number;
}) {
  const ok = Number.isFinite(value);
  const frac = ok ? Math.min(1, Math.max(0, (value - min) / Math.max(1e-9, max - min))) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-9 text-right text-[8px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-sm border border-[#2A2C32] bg-[#101114]">
        <div
          className="h-full rounded-sm"
          style={{
            width: `${frac * 100}%`,
            background: `linear-gradient(to right, ${color}55, ${color})`,
            boxShadow: `0 0 6px ${color}66`,
            transition: "width 80ms linear",
          }}
        />
      </div>
      <span className="w-[64px] font-mono text-[10px] tabular-nums text-[#D8DCE2]">
        {ok ? `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}` : "—"}
      </span>
    </div>
  );
}

/** Live friction-circle dot ("g-meter") — lateral on x, longitudinal on y. */
function GDot({ latG, longG }: { latG: number; longG: number }) {
  const S = 92;
  const c = S / 2;
  const gMax = 2.6;
  const x = c + (Math.max(-gMax, Math.min(gMax, latG)) / gMax) * (c - 10);
  const y = c - (Math.max(-gMax, Math.min(gMax, longG)) / gMax) * (c - 10);
  return (
    <svg width={S} height={S} role="img" aria-label={`g meter: ${latG.toFixed(2)} lateral, ${longG.toFixed(2)} longitudinal`}>
      {[1, 2].map((g) => (
        <circle key={g} cx={c} cy={c} r={((c - 10) * g) / gMax} fill="none" stroke="#2A2C32" strokeWidth={1} />
      ))}
      <line x1={c} y1={6} x2={c} y2={S - 6} stroke="#2A2C32" strokeWidth={1} />
      <line x1={6} y1={c} x2={S - 6} y2={c} stroke="#2A2C32" strokeWidth={1} />
      <text x={c + 2} y={12} fontSize={7} fill="#5A5F66">accel</text>
      <text x={c + 2} y={S - 5} fontSize={7} fill="#5A5F66">brake</text>
      <circle cx={x} cy={y} r={4.5} fill="#FFC627" style={{ filter: "drop-shadow(0 0 4px #FFC627AA)" }} />
      <text x={4} y={12} fontSize={7} fill="#5A5F66">2g</text>
    </svg>
  );
}

/** Sportbike tachometer: the scale starts low on the LEFT and wraps clockwise
 *  over the entire top of the dial (≈200° sweep), like a supersport cluster —
 *  gradient power band, minor ticks every 500, numerals every 1000, hatched
 *  redline sector, glowing needle, and a MotoGP-style progressive LED shift
 *  strip across the top that walks green → amber → red and strobes at the
 *  limiter. */
function Tachometer({ rpm, revLimit }: { rpm: number; revLimit: number }) {
  const maxRpm = Math.ceil(revLimit / 1000) * 1000;
  const W = 250;
  const H = 152;
  const cx = W / 2;
  const cy = 132;
  const R = 104;
  // Angle map (math convention, y-up): 190° (low left) → −10° (low right),
  // sweeping over the top. SVG y is down, so py = cy − R·sinθ.
  const A0 = 190;
  const A1 = -10;
  const thetaOf = (r: number) => ((A0 + (Math.min(Math.max(r, 0), maxRpm) / maxRpm) * (A1 - A0)) * Math.PI) / 180;
  const pt = (r: number, radius: number): [number, number] => {
    const th = thetaOf(r);
    return [cx + radius * Math.cos(th), cy - radius * Math.sin(th)];
  };
  const arc = (from: number, to: number, radius: number) => {
    const [x0, y0] = pt(from, radius);
    const [x1, y1] = pt(to, radius);
    const large = ((to - from) / maxRpm) * (A0 - A1) > 180 ? 1 : 0;
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const [nx, ny] = pt(rpm, R - 16);
  const ledCount = 9;
  const ledFrom = 0.78 * revLimit; // strip arms through the top of the band
  const ledStep = (revLimit - ledFrom) / ledCount;
  const atLimiter = rpm >= revLimit - 150;
  return (
    <svg width={W} height={H} role="img" aria-label={`Tachometer ${rpm.toFixed(0)} rpm`} className="block">
      <defs>
        <linearGradient id="tachBand" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4FC3F7" />
          <stop offset="45%" stopColor="#FFC627" />
          <stop offset="85%" stopColor="#FF8A65" />
          <stop offset="100%" stopColor="#FF5252" />
        </linearGradient>
        <filter id="needleGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id="redHatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="#FF525222" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="#FF5252" strokeWidth="1.6" opacity="0.8" />
        </pattern>
      </defs>
      {/* dial face */}
      <path d={arc(0, maxRpm, R)} fill="none" stroke="#16171B" strokeWidth={22} strokeLinecap="round" />
      <path d={arc(0, maxRpm, R)} fill="none" stroke="#2A2C32" strokeWidth={1} opacity={0.9} />
      {/* redline sector */}
      <path d={arc(revLimit, maxRpm, R)} fill="none" stroke="url(#redHatch)" strokeWidth={20} />
      <path d={arc(revLimit, maxRpm, R)} fill="none" stroke="#FF5252" strokeWidth={2.5} />
      {/* live band */}
      <path
        d={arc(0, Math.max(60, rpm), R)}
        fill="none"
        stroke="url(#tachBand)"
        strokeWidth={9}
        strokeLinecap="round"
        opacity={0.95}
      />
      {/* ticks: minor every 500, major + numeral every 1000 */}
      {Array.from({ length: maxRpm / 500 + 1 }, (_, i) => {
        const r = i * 500;
        const major = r % 1000 === 0;
        const [x1, y1] = pt(r, R - 11);
        const [x2, y2] = pt(r, R - (major ? 22 : 16));
        const red = r >= revLimit;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={red ? "#FF5252" : major ? "#9097A0" : "#5A5F66"} strokeWidth={major ? 2 : 1} />
            {major && (
              <text {...(() => { const [tx, ty] = pt(r, R - 33); return { x: tx, y: ty + 3.5 }; })()}
                fontSize={9.5} fontFamily="monospace" fontWeight={red ? 700 : 400}
                fill={red ? "#FF5252" : "#9097A0"} textAnchor="middle">
                {r / 1000}
              </text>
            )}
          </g>
        );
      })}
      {/* LED shift strip — walks up across the very top, strobes on limiter */}
      {Array.from({ length: ledCount }, (_, i) => {
        const arm = ledFrom + i * ledStep;
        const [lx, ly] = pt(arm + ledStep / 2, R + 16);
        const lit = rpm >= arm;
        const color = i < 4 ? "#A5D6A7" : i < 7 ? "#FFC627" : "#FF5252";
        return (
          <circle key={i} cx={lx} cy={ly} r={3.6}
            fill={lit ? color : "#1B1D22"} stroke={lit ? color : "#2A2C32"} strokeWidth={1}
            style={lit ? { filter: "drop-shadow(0 0 3px " + color + ")" } : undefined}>
            {lit && atLimiter && (
              <animate attributeName="opacity" values="1;0.15;1" dur="0.22s" repeatCount="indefinite" />
            )}
          </circle>
        );
      })}
      {/* needle */}
      <g filter="url(#needleGlow)">
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FAFAFA" strokeWidth={2.6} strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FFC627" strokeWidth={1} strokeLinecap="round" />
      </g>
      <circle cx={cx} cy={cy} r={6} fill="#16171B" stroke="#5A5F66" strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={2} fill="#FFC627" />
      {/* digital rpm */}
      <text x={cx} y={cy - 24} fontSize={19} fontFamily="monospace" fill="#D8DCE2" textAnchor="middle" fontWeight={700}>
        {rpm.toFixed(0)}
      </text>
      <text x={cx} y={cy - 12} fontSize={7} fill="#5A5F66" textAnchor="middle"
        style={{ textTransform: "uppercase", letterSpacing: 2 }}>
        rpm × 1000
      </text>
    </svg>
  );
}

/** Per-sample dt weights for time-weighted histograms. */
function dtWeights(tS: number[]): number[] {
  return tS.map((tv, i) => tv - (i > 0 ? tS[i - 1]! : 0));
}

// ---- Channel analyzer ---------------------------------------------------------
// Free-form slice-and-dice over the lap channels: pick any channel (incl. the
// engine power joined from the sweep), view it as a distance trace, time
// trace, or time-weighted histogram, filter by limit state and a distance
// window, tune the bin count, overlay B — with time-weighted stats for
// exactly the filtered slice. "How much time do we spend above 12k in
// corner-limited sections?" is now a three-click question.

type AnalyzerMode = "dist" | "time" | "hist";

const ANALYZER_CHANNELS: { key: string; label: string; unit: string }[] = [
  { key: "speed", label: "speed", unit: "km/h" },
  { key: "rpm", label: "engine rpm", unit: "rpm" },
  { key: "power", label: "engine power", unit: "kW" },
  { key: "latG", label: "lateral g", unit: "g" },
  { key: "longG", label: "longitudinal g", unit: "g" },
  { key: "gear", label: "gear", unit: "" },
  { key: "fuel", label: "fuel burned", unit: "g" },
];

function analyzerValues(run: LapRun, key: string): number[] {
  const ch = run.ch;
  if (key === "power") {
    const pts = [...run.source.points].sort((a, b) => a.rpm - b.rpm);
    const rpms = pts.map((p) => p.rpm);
    const pw = pts.map((p) => p.lastCycle.brakePowerKW);
    return ch.rpm.map((r) => interpAt(rpms, pw, r));
  }
  switch (key) {
    case "speed": return ch.vMps.map((v) => v * 3.6);
    case "rpm": return [...ch.rpm];
    case "latG": return [...ch.latG];
    case "longG": return [...ch.longG];
    case "gear": return [...ch.gear];
    case "fuel": return ch.fuelCumKg.map((f) => f * 1000);
    default: return [];
  }
}

const ALL_LIMITS: LimitState[] = ["power", "grip", "corner", "brake", "coast"];

function ChannelAnalyzer({ runA, runB }: { runA: LapRun; runB: LapRun | null }) {
  const [key, setKey] = useState("rpm");
  const [mode, setMode] = useState<AnalyzerMode>("hist");
  const [bins, setBins] = useState(28);
  const [withB, setWithB] = useState(true);
  const [limits, setLimits] = useState<Set<LimitState>>(new Set(ALL_LIMITS));
  const totalDist = runA.ch.distM[runA.ch.distM.length - 1] ?? 0;
  const [d0, setD0] = useState(0);
  const [d1, setD1] = useState(Infinity);
  const def = ANALYZER_CHANNELS.find((c) => c.key === key)!;

  const slice = (run: LapRun) => {
    const vals = analyzerValues(run, key);
    const w = dtWeights(run.ch.tS);
    const total = run.ch.distM[run.ch.distM.length - 1] ?? 0;
    const hi = Number.isFinite(d1) ? d1 : total;
    const mask = vals.map(
      (_, i) => limits.has(run.ch.limit[i]!) && run.ch.distM[i]! >= d0 && run.ch.distM[i]! <= hi,
    );
    return { vals, w, mask, run };
  };
  const A = useMemo(slice.bind(null, runA), [runA, key, limits, d0, d1]);
  const B = useMemo(() => (runB && withB ? slice(runB) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runB, withB, key, limits, d0, d1]);

  const stats = useMemo(() => {
    let wSum = 0;
    let vSum = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < A.vals.length; i++) {
      if (!A.mask[i]) continue;
      const v = A.vals[i]!;
      wSum += A.w[i]!;
      vSum += v * A.w[i]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return wSum > 0
      ? { tS: wSum, mean: vSum / wSum, min: mn, max: mx }
      : null;
  }, [A]);

  const toHist = (s: NonNullable<ReturnType<typeof slice>>, color: string, label: string): HistSeries => ({
    values: s.vals.filter((_, i) => s.mask[i]),
    weights: s.w.filter((_, i) => s.mask[i]),
    color,
    label,
  });

  const traceSeries = useMemo(() => {
    if (mode === "hist") return null;
    const xsA = mode === "dist" ? runA.ch.distM : runA.ch.tS;
    const yA = A.vals.map((v, i) => (A.mask[i] ? v : Number.NaN));
    const series = [
      { label: `A ${runA.vehicle.name}`, y: yA, color: "#FFC627", width: 1.6, showPoints: false },
    ];
    if (B && runB) {
      // resample B onto A's x grid; mask carries over approximately by x
      const xsB = mode === "dist" ? runB.ch.distM : runB.ch.tS;
      const yB = xsA.map((x) => interpAt(xsB, B.vals, x));
      series.push({ label: `B ${runB.vehicle.name}`, y: yB, color: "#4FC3F7", width: 1.3, showPoints: false });
    }
    return { xs: xsA, series };
  }, [mode, A, B, runA, runB]);

  const chip = (s: LimitState) => {
    const on = limits.has(s);
    return (
      <button
        key={s}
        type="button"
        aria-pressed={on}
        onClick={() => {
          const next = new Set(limits);
          if (on) next.delete(s);
          else next.add(s);
          if (next.size === 0) ALL_LIMITS.forEach((x) => next.add(x)); // never empty
          setLimits(next);
        }}
        className="rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase"
        style={{
          color: on ? LIMIT_COLOR[s] : "#5A5F66",
          borderColor: on ? `${LIMIT_COLOR[s]}88` : "#2A2C32",
          background: on ? `${LIMIT_COLOR[s]}14` : "transparent",
        }}
      >
        {s}
      </button>
    );
  };

  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">Channel analyzer</span>
        <select
          aria-label="Analyzer channel"
          className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-0.5 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        >
          {ANALYZER_CHANNELS.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-sm border border-[#2A2C32]">
          {(["dist", "time", "hist"] as AnalyzerMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "px-2 py-0.5 text-[9px] uppercase tracking-wider " +
                (mode === m ? "bg-[#FFC627] font-semibold text-[#0E0E10]" : "text-[#9097A0] hover:text-[#FFC627]")
              }
            >
              {m === "dist" ? "vs distance" : m === "time" ? "vs time" : "histogram"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">{ALL_LIMITS.map(chip)}</div>
        <label className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[#5A5F66]">
          window
          <input type="number" value={d0} min={0} step={10} aria-label="Window start (m)"
            onChange={(e) => setD0(Math.max(0, parseFloat(e.target.value) || 0))}
            className="w-14 rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1 py-0.5 font-mono text-[10px] text-[#D8DCE2]" />
          –
          <input type="number" value={Number.isFinite(d1) ? d1 : Math.round(totalDist)} step={10} aria-label="Window end (m)"
            onChange={(e) => setD1(parseFloat(e.target.value) || totalDist)}
            className="w-14 rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1 py-0.5 font-mono text-[10px] text-[#D8DCE2]" />
          m
        </label>
        {mode === "hist" && (
          <label className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[#5A5F66]">
            bins
            <input type="range" min={8} max={60} value={bins} aria-label="Histogram bins"
              onChange={(e) => setBins(parseInt(e.target.value, 10))} className="w-20 accent-[#FFC627]" />
            <span className="font-mono text-[10px] text-[#D8DCE2]">{bins}</span>
          </label>
        )}
        {runB && (
          <label className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[#5A5F66]">
            <input type="checkbox" checked={withB} onChange={(e) => setWithB(e.target.checked)} className="accent-[#4FC3F7]" />
            overlay B
          </label>
        )}
      </div>
      {stats && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[#16171B] px-3 py-1.5">
          <Stat label="time in slice" value={`${stats.tS.toFixed(2)} s`} highlight />
          <Stat label="t-wtd mean" value={`${stats.mean.toFixed(1)} ${def.unit}`} />
          <Stat label="min" value={`${stats.min.toFixed(1)} ${def.unit}`} />
          <Stat label="max" value={`${stats.max.toFixed(1)} ${def.unit}`} />
        </div>
      )}
      <div className="p-2">
        {mode === "hist" ? (
          <MiniHistogram
            title={`${def.label} — time-weighted, filtered slice`}
            unit={def.unit}
            series={toHist(A, "#FFC627", "A")}
            overlay={B ? toHist(B, "#4FC3F7", "B") : undefined}
            bins={bins}
            height={210}
          />
        ) : (
          traceSeries && (
            <LinePlot
              title={`${def.label} ${mode === "dist" ? "vs distance" : "vs time"} — filtered (gaps = outside slice)`}
              xs={traceSeries.xs}
              series={traceSeries.series}
              xLabel={mode === "dist" ? "distance (m)" : "time (s)"}
              yLabel={def.unit}
              height={230}
            />
          )
        )}
      </div>
    </section>
  );
}

function histSeries(run: LapRun, get: (ch: LapChannels, i: number) => number, label: string, color: string): HistSeries {
  return {
    values: run.ch.tS.map((_, i) => get(run.ch, i)),
    weights: dtWeights(run.ch.tS),
    color,
    label,
  };
}

function HeadlineRow({ tag, run, accent, deltaVs }: { tag: string; run: LapRun; accent?: boolean; deltaVs?: LapRun }) {
  const tm = run.lap.telemetry;
  const dt = deltaVs ? run.lap.lapTimeS - deltaVs.lap.lapTimeS : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[#2A2C32] px-3 py-2">
      <span className={"font-mono text-[11px] " + (accent ? "text-[#FFC627]" : "text-[#4FC3F7]")}>
        {tag} · {run.vehicle.name}
      </span>
      <Stat label="lap" value={`${run.lap.lapTimeS.toFixed(2)} s`} highlight={accent} />
      {dt != null && (
        <span className={"font-mono text-[11px] " + (dt > 0 ? "text-[#FF8A65]" : "text-[#A5D6A7]")}>
          {dt > 0 ? "+" : ""}{dt.toFixed(2)} s
        </span>
      )}
      <Stat label="avg" value={`${(run.lap.avgSpeedMps * 3.6).toFixed(1)} km/h`} />
      <Stat label="top" value={`${tm.vMaxKph.toFixed(0)} km/h`} />
      <Stat label="shifts" value={String(run.lap.shiftCount)} />
      <Stat label="avg rpm" value={tm.avgRpm.toFixed(0)} />
      <Stat label="max lat" value={`${tm.maxLatG.toFixed(2)} g`} />
      <Stat label="max brake" value={`${tm.maxBrakeG.toFixed(2)} g`} />
      <Stat label="fuel" value={`${(run.lap.fuelKg * 1000).toFixed(0)} g`} />
      <Stat label="CO₂" value={`${(run.lap.co2Kg * 1000).toFixed(0)} g`} />
      <Stat label="power-limited" value={`${(tm.pctPowerLimited * 100).toFixed(0)}%`} highlight />
    </div>
  );
}

/** Stacked bar of lap time by limit state — the "where does the engine matter"
 *  strip. Gold (power) is the engine team's share of the lap. */
function LimitBar({ run }: { run: LapRun }) {
  const fracs = limitFractions(run.ch);
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[8px] uppercase tracking-wider text-[#5A5F66]">lap time by limiting factor — A</span>
        <span className="text-[8px] uppercase tracking-wider text-[#5A5F66]">
          gold = engine-bound (torque here buys lap time)
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-sm border border-[#2A2C32]">
        {fracs.map(({ state, frac }) => (
          <div
            key={state}
            style={{ width: `${frac * 100}%`, background: LIMIT_COLOR[state] }}
            title={`${state}: ${(frac * 100).toFixed(0)}% of lap time`}
            className="flex items-center justify-center font-mono text-[7px] text-black/70"
          >
            {frac >= 0.09 ? `${state} ${(frac * 100).toFixed(0)}%` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[9px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      <span className={"font-mono tabular-nums " + (highlight ? "text-[13px] text-[#FFC627]" : "text-[11px] text-[#D8DCE2]")}>
        {value}
      </span>
    </span>
  );
}
