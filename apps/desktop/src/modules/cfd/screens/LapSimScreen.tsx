// Lap Sim screen: the full 2D lap-sim workbench. Runs the SAME physics as the
// FSAE event scoring (autocrossLapOpts/enduranceLapOpts — single source) but
// with channel traces enabled, then turns them into the race-engineer toolkit:
// channel-colored track map, speed/RPM/gear traces, g-g diagram, limit-state
// breakdown (where the ENGINE is the binding constraint), A/B comparison with
// a cumulative delta-time trace, and a MoTeC-style CSV export for hand-off.

import { useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { ReportButton } from "../components/ReportButton";
import { LinePlot } from "../components/charts/LinePlot";
import { ChannelTrackMap } from "../components/charts/ChannelTrackMap";
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
                {mapData && <ChannelTrackMap track={visual} fracs={mapData.fracs} colors={mapData.colors} height={330} />}
                <p className="px-3 pb-2 text-[9px] leading-tight text-[#5A5F66]">
                  Channel mapped onto the traced layout by lap-distance fraction (the sim integrates the radius profile).
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
          </div>
        )}
      </div>
    </div>
  );
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
