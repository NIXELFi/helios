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
      {/* Dash — real-telemetry look: tach + gear + speed, then the data grid */}
      <div className="flex flex-wrap items-center gap-4 border-t border-[#2A2C32] px-3 py-2">
        <Tachometer rpm={cur.rpm} revLimit={runA.vehicle.revLimitRpm} />
        <div className="flex flex-col items-center" aria-label="Gear indicator">
          <span className="text-[8px] uppercase tracking-wider text-[#5A5F66]">gear</span>
          <span className="font-mono text-[42px] leading-none text-[#FFC627]">{cur.gear || "N"}</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-[8px] uppercase tracking-wider text-[#5A5F66]">km/h</span>
          <span className="font-mono text-[34px] leading-none text-[#D8DCE2] tabular-nums">
            {cur.speedKph.toFixed(0)}
          </span>
          <span
            className="mt-1 rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase"
            style={{ color: LIMIT_COLOR[cur.limit], border: `1px solid ${LIMIT_COLOR[cur.limit]}55` }}
          >
            {cur.limit}
          </span>
        </div>
        {/* Engine + chassis data grid */}
        <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <Stat label="power" value={Number.isFinite(cur.powerKw) ? `${cur.powerKw.toFixed(1)} kW` : "—"} highlight />
          <Stat label="BMEP" value={Number.isFinite(cur.bmep) ? `${cur.bmep.toFixed(1)} bar` : "—"} />
          <Stat label="VE" value={Number.isFinite(cur.ve) ? `${(cur.ve * 100).toFixed(0)}%` : "—"} />
          <Stat label="EGT" value={Number.isFinite(cur.egt) ? `${cur.egt.toFixed(0)} K` : "—"} />
          <Stat label="lat" value={`${cur.latG.toFixed(2)} g`} />
          <Stat label="long" value={`${cur.longG.toFixed(2)} g`} />
          <Stat label="fuel" value={`${cur.fuelG.toFixed(1)} g`} />
          <Stat label="dist" value={`${cur.dist.toFixed(0)} m`} />
        </div>
      </div>
    </div>
  );
}

/** SVG tachometer: 240° sweep to the rev ceiling, redline band, needle, and a
 *  shift light that arms near the limiter (the optimal-shift policy rides
 *  each gear to the crossover, usually near redline). */
function Tachometer({ rpm, revLimit }: { rpm: number; revLimit: number }) {
  const maxRpm = Math.ceil(revLimit / 1000) * 1000;
  const a0 = -210; // degrees, gauge start (left-down)
  const sweep = 240;
  const angleOf = (r: number) => ((a0 + (Math.min(r, maxRpm) / maxRpm) * sweep) * Math.PI) / 180;
  const cx = 62;
  const cy = 64;
  const R = 50;
  const arc = (from: number, to: number, radius: number) => {
    const p0 = [cx + radius * Math.cos(angleOf(from)), cy + radius * Math.sin(angleOf(from))];
    const p1 = [cx + radius * Math.cos(angleOf(to)), cy + radius * Math.sin(angleOf(to))];
    const large = ((to - from) / maxRpm) * sweep > 180 ? 1 : 0;
    return `M ${p0[0]!.toFixed(1)} ${p0[1]!.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${p1[0]!.toFixed(1)} ${p1[1]!.toFixed(1)}`;
  };
  const needle = angleOf(rpm);
  const shiftLit = rpm >= 0.93 * revLimit;
  return (
    <svg width={124} height={118} role="img" aria-label={`Tachometer ${rpm.toFixed(0)} rpm`}>
      <path d={arc(0, maxRpm, R)} fill="none" stroke="#2A2C32" strokeWidth={7} />
      <path d={arc(revLimit, maxRpm, R)} fill="none" stroke="#FF5252" strokeWidth={7} />
      <path d={arc(0, Math.max(1, rpm), R)} fill="none" stroke="#FFC627" strokeWidth={4} opacity={0.85} />
      {Array.from({ length: maxRpm / 1000 + 1 }, (_, i) => {
        const a = angleOf(i * 1000);
        const r1 = R - 7;
        const r2 = R - (i % 2 === 0 ? 13 : 10);
        return (
          <g key={i}>
            <line
              x1={cx + r1 * Math.cos(a)} y1={cy + r1 * Math.sin(a)}
              x2={cx + r2 * Math.cos(a)} y2={cy + r2 * Math.sin(a)}
              stroke={i * 1000 >= revLimit ? "#FF5252" : "#5A5F66"} strokeWidth={1.5}
            />
            {i % 2 === 0 && (
              <text
                x={cx + (R - 20) * Math.cos(a)} y={cy + (R - 20) * Math.sin(a) + 3}
                fontSize={7.5} fontFamily="monospace" fill="#5A5F66" textAnchor="middle"
              >
                {i}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1={cx} y1={cy}
        x2={cx + (R - 14) * Math.cos(needle)} y2={cy + (R - 14) * Math.sin(needle)}
        stroke="#FAFAFA" strokeWidth={2} strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={3.5} fill="#FAFAFA" />
      {/* shift light */}
      <circle cx={cx} cy={cy - R - 6 + 18} r={4} fill={shiftLit ? "#FF5252" : "#2A2C32"}>
        {shiftLit && <animate attributeName="opacity" values="1;0.3;1" dur="0.4s" repeatCount="indefinite" />}
      </circle>
      <text x={cx} y={cy + 24} fontSize={13} fontFamily="monospace" fill="#D8DCE2" textAnchor="middle">
        {rpm.toFixed(0)}
      </text>
      <text x={cx} y={cy + 34} fontSize={7} fill="#5A5F66" textAnchor="middle" style={{ textTransform: "uppercase", letterSpacing: 1 }}>
        rpm ×1000
      </text>
    </svg>
  );
}

/** Per-sample dt weights for time-weighted histograms. */
function dtWeights(tS: number[]): number[] {
  return tS.map((tv, i) => tv - (i > 0 ? tS[i - 1]! : 0));
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
