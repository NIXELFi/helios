// Lap Sim screen: the full 2D lap-sim workbench. Runs the SAME physics as the
// FSAE event scoring (autocrossLapOpts/enduranceLapOpts — single source) but
// with channel traces enabled, then turns them into the race-engineer toolkit:
// channel-colored track map, speed/RPM/gear traces, g-g diagram, limit-state
// breakdown (where the ENGINE is the binding constraint), A/B comparison with
// a cumulative delta-time trace, and a MoTeC-style CSV export for hand-off.

import { useEffect, useMemo, useState } from "react";

import { save } from "@helios/plugin-sdk";
import { LinePlot } from "./charts/LinePlot";
import { ChannelTrackMap } from "./charts/ChannelTrackMap";
import { MiniHistogram, type HistSeries } from "./charts/MiniHistogram";
import { GGDiagram, LIMIT_COLOR, LIMIT_LABEL } from "./charts/GGDiagram";
import type { CurveSource } from "./sources";
import { rampColor, rampColors } from "./lib/colorScale";
import { buildLapChannelsCsv } from "./lib/lapChannelsCsv";
import { fileTimestamp, slugify } from "./lib/io";
import {
  carKeyForConfig,
  vehicleForCar,
  torqueCurveFromSweep,
  fuelMapFromSweep,
  simLap,
  autocrossLapOpts,
  enduranceLapOpts,
  optimalShiftSpeeds,
  cornerSignsAtFracs,
  lapSectors,
  sectorDeltas,
  applyVdParam,
  runVdSweep,
  vdSweepValues,
  VD_PARAMS,
  VD_PARAM_META,
  VD_PARAM_RANGE,
  AUTOCROSS_2026,
  ENDURANCE_2026,
  AUTOCROSS_2026_VISUAL,
  ENDURANCE_2026_VISUAL,
  type LapResult,
  type LapChannels,
  type LapSector,
  type LimitState,
  type VehicleConfig,
  type VdParam,
  type VdSweepRow,
  type LapOpts,
} from "@helios/lapsim-core";

type EventKey = "autocross" | "endurance";

const EVENTS: { key: EventKey; label: string; note: string }[] = [
  { key: "autocross", label: "Autocross", note: "flat-out" },
  { key: "endurance", label: "Endurance", note: "race pace" },
];

type ChannelKey = "speed" | "rpm" | "gear" | "latG" | "longG" | "throttle" | "brake" | "limit" | "fuel";

const CHANNELS: { key: ChannelKey; label: string; unit: string; get: (ch: LapChannels, i: number) => number }[] = [
  { key: "speed", label: "speed", unit: "km/h", get: (ch, i) => ch.vMps[i]! * 3.6 },
  { key: "rpm", label: "rpm", unit: "rpm", get: (ch, i) => ch.rpm[i]! },
  { key: "gear", label: "gear", unit: "", get: (ch, i) => ch.gear[i]! },
  { key: "latG", label: "lat g", unit: "g", get: (ch, i) => ch.latG[i]! },
  { key: "longG", label: "long g", unit: "g", get: (ch, i) => ch.longG[i]! },
  { key: "throttle", label: "throttle", unit: "", get: (ch, i) => ch.throttle[i]! },
  { key: "brake", label: "brake", unit: "", get: (ch, i) => ch.brake[i]! },
  { key: "limit", label: "limit state", unit: "", get: (ch, i) => ch.gear[i]! /* unused (categorical) */ },
  { key: "fuel", label: "fuel burned", unit: "g", get: (ch, i) => ch.fuelCumKg[i]! * 1000 },
];

interface LapRun {
  source: CurveSource;
  vehicle: VehicleConfig;
  lap: LapResult;
  ch: LapChannels;
  /** Optimal upshift speeds (m/s) per gear — drives the dash shift light. */
  shiftV: number[];
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

export function LapSimScreen({ sources, vehicleConfig }: { sources: CurveSource[]; vehicleConfig: VehicleConfig }) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [event, setEvent] = useState<EventKey>("autocross");
  const [channel, setChannel] = useState<ChannelKey>("speed");
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // VD-sweep mode: vary ONE vehicle-dynamics knob on source A's engine across a
  // range. Gated behind `vdMode` so the default study A/B path is untouched
  // when it's off. The B-run becomes source A's curve on the swept vehicle.
  const [vdMode, setVdMode] = useState<boolean>(false);
  const [vdParam, setVdParam] = useState<VdParam>("massKg");
  const [vdStart, setVdStart] = useState<number>(VD_PARAM_RANGE.massKg.start);
  const [vdStop, setVdStop] = useState<number>(VD_PARAM_RANGE.massKg.stop);
  const [vdStep, setVdStep] = useState<number>(VD_PARAM_RANGE.massKg.step);

  const sourceA = sources.find((s) => s.id === sourceId) ?? sources[0] ?? null;
  const sourceB = sources.find((s) => s.id === compareId && s.id !== sourceA?.id) ?? null;

  const track = event === "autocross" ? AUTOCROSS_2026 : ENDURANCE_2026;
  const visual = event === "autocross" ? AUTOCROSS_2026_VISUAL : ENDURANCE_2026_VISUAL;

  // Resolve the vehicle a CurveSource scores with (preset identity + the user's
  // tuning) — the SAME resolution the A/B path uses. Exposed so VD-sweep mode
  // can patch the RESOLVED vehicle (post-identity-forcing) and feed it back in
  // via `vehicleOverride`, without re-running vehicleForCar (which would clobber
  // a mass sweep back to the preset — see vehicle.ts IDENTITY_KEYS).
  const resolveVehicle = (src: CurveSource): VehicleConfig =>
    vehicleForCar(carKeyForConfig(src.configName), vehicleConfig);

  // `vehicleOverride` runs the SAME engine curve (source A) with a DIFFERENT
  // vehicle — the seam the VD sweep needs (its B-run is source A's curve on a
  // swept vehicle). Omitted → the default A/B path (vehicle derived from src).
  const runFor = (src: CurveSource | null, vehicleOverride?: VehicleConfig): LapRun | null => {
    if (!src) return null;
    const curve = torqueCurveFromSweep(src.points);
    if (curve.length === 0) return null;
    const vehicle = vehicleOverride ?? resolveVehicle(src);
    const opts = event === "autocross" ? autocrossLapOpts() : enduranceLapOpts();
    // Variable-throttle fuel (Willans from the solver sweep) when available.
    const fuelMap = fuelMapFromSweep(src.points) ?? undefined;
    const lap = simLap(curve, vehicle, track, { ...opts, fuelMap, channels: true });
    return lap.channels
      ? { source: src, vehicle, lap, ch: lap.channels, shiftV: optimalShiftSpeeds(curve, vehicle) }
      : null;
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runA = useMemo(() => runFor(sourceA), [sourceA, event, vehicleConfig]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const studyRunB = useMemo(() => runFor(sourceB), [sourceB, event, vehicleConfig]);

  // ---- VD sweep (vehicle-dynamics knob, gated by vdMode) -------------------
  // The RESOLVED baseline vehicle for source A (identity already forced) — the
  // patch target for applyVdParam (must NOT go back through vehicleForCar).
  const baseVehicleA = useMemo(
    () => (sourceA ? resolveVehicle(sourceA) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceA, vehicleConfig],
  );
  // A measured tire (.tir) overrides μ(Fz) entirely → the %dropoff sweep is
  // meaningless then (mass/cg/rsd stay valid). Gate that param.
  const tirLoaded = !!baseVehicleA?.tire;
  // With a roll config present, lateral load transfer keys on the CG-to-roll-axis
  // arm `hRollArmM`, NOT raw `cgHeightM` (lapSim.ts axleCaps) — so a cgHeightM
  // sweep freezes lateral capacity and the lap-time trend INVERTS (higher CG
  // reads as faster via the longitudinal traction path only). A wrong-way plot,
  // so gate cgHeightM the same way muDropoffPct is gated under a .tir. Correct on
  // a lumped-model car (no roll), where chi() uses cgHeightM directly.
  const rollPresent = !!baseVehicleA?.roll;
  const vdParamDisabled = (p: VdParam): boolean =>
    (p === "muDropoffPct" && tirLoaded) || (p === "cgHeightM" && rollPresent);

  // A disabled param must never be the active sweep param — fall back to the
  // first still-selectable one (massKg is always valid). Runs on the resolved
  // baseline changing (e.g. loading a .tir, switching to a roll-config car).
  useEffect(() => {
    if (vdParamDisabled(vdParam)) {
      const next = VD_PARAMS.find((p) => !vdParamDisabled(p));
      if (next) selectVdParam(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tirLoaded, rollPresent, vdParam]);

  // Full sweep table (value, lapTimeS, maxLatG, balanceMargin, fuelKg).
  const vdRows = useMemo<VdSweepRow[]>(() => {
    if (!vdMode || !sourceA || !baseVehicleA || vdParamDisabled(vdParam)) return [];
    const curve = torqueCurveFromSweep(sourceA.points);
    if (curve.length === 0) return [];
    const opts = event === "autocross" ? autocrossLapOpts() : enduranceLapOpts();
    const fuelMap = fuelMapFromSweep(sourceA.points) ?? undefined;
    const lapOpts: LapOpts = { ...opts, fuelMap };
    return runVdSweep(curve, baseVehicleA, track, { param: vdParam, start: vdStart, stop: vdStop, step: vdStep }, lapOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vdMode, sourceA, baseVehicleA, vdParam, vdStart, vdStop, vdStep, event, track]);

  // The baseline value of the swept param on A's resolved vehicle — drives the
  // "you are here" marker on the sweep plot and the baseline B-run choice.
  const vdBaselineValue = useMemo<number | null>(() => {
    if (!baseVehicleA) return null;
    switch (vdParam) {
      case "massKg": return baseVehicleA.massKg;
      case "cgHeightM": return baseVehicleA.cgHeightM;
      case "rsdFront": return baseVehicleA.roll?.rsdFront ?? null;
      case "muDropoffPct": return null; // shown via the chip, not on this axis
    }
  }, [baseVehicleA, vdParam]);

  // The raw stop need not land on the inclusive value grid (e.g. RSD 0.376→0.605
  // step 0.02 stops at ≈0.596). The plot only draws grid points, so snap the
  // B-run / headline to the LAST grid value — using the SAME vdSweepValues() the
  // plot uses — so B is always a plotted point rather than an off-grid setup with
  // no marker. Falls back to vdStop if the grid is somehow empty.
  const vdStopSnapped = useMemo(() => {
    const grid = vdSweepValues({ param: vdParam, start: vdStart, stop: vdStop, step: vdStep });
    return grid.at(-1) ?? vdStop;
  }, [vdParam, vdStart, vdStop, vdStep]);

  // VD-mode B-run: source A's engine curve on the SWEPT vehicle at the sweep's
  // last GRID value — so the existing A/B visuals (deltaT, sectors, g-g, headline)
  // immediately read "baseline vs swept setup" against a setup that's plotted.
  // Built via the runFor seam.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const vdRunB = useMemo(() => {
    if (!vdMode || !sourceA || !baseVehicleA || vdParamDisabled(vdParam)) return null;
    return runFor(sourceA, applyVdParam(baseVehicleA, vdParam, vdStopSnapped));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vdMode, sourceA, baseVehicleA, vdParam, vdStopSnapped, event]);

  // The B the rest of the screen compares against: the swept vehicle in VD mode,
  // else the chosen study source. This is the ONLY join point — everything below
  // (deltaT, sectors, plots, headline) is unchanged.
  const runB = vdMode ? vdRunB : studyRunB;

  // Cumulative time delta B−A on A's distance grid (positive = A ahead).
  const deltaT = useMemo(() => {
    if (!runA || !runB) return null;
    return runA.ch.distM.map((d, i) => interpAt(runB.ch.distM, runB.ch.tS, d) - runA.ch.tS[i]!);
  }, [runA, runB]);

  // Signed lateral g for the g-g circle: the sim's latG is unsigned (radius-
  // only track), the traced layout supplies the turn DIRECTION per sample.
  const signedLatG = useMemo(() => {
    if (!runA) return null;
    const total = runA.ch.distM[runA.ch.distM.length - 1] || 1;
    const signs = cornerSignsAtFracs(visual.centerline, runA.ch.distM.map((d) => d / total));
    return runA.ch.latG.map((g, i) => g * (signs[i] || 1));
  }, [runA, visual]);

  // Corner-complex sectors on A (boundaries at brake applications) and B's
  // per-sector time deltas over the same pieces of road.
  const sectors = useMemo(() => (runA ? lapSectors(runA.ch) : []), [runA]);
  const secDeltas = useMemo(
    () => (runB && sectors.length ? sectorDeltas(sectors, runB.ch) : null),
    [sectors, runB],
  );

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

  // Pick a VD param and seed its physical default start/stop/step (RSD spans the
  // ARB-calculator window, %dropoff spans sens 0–~0.3, etc. — see VD_PARAM_RANGE).
  function selectVdParam(p: VdParam) {
    setVdParam(p);
    const r = VD_PARAM_RANGE[p];
    setVdStart(r.start);
    setVdStop(r.stop);
    setVdStep(r.step);
  }

  // Small sweep-summary CSV: one row per swept value with the headline metrics.
  async function exportVdSweepCsv() {
    if (!sourceA || vdRows.length === 0) return;
    try {
      const meta = VD_PARAM_META[vdParam];
      const header = `# Helios lap-sim VD sweep — ${meta.label} (${meta.unit})\n# source ${sourceA.configName} · ${event} · ${track.name}\n# generated ${new Date().toISOString()}\n`;
      const cols = `value,lapTimeS,maxLatG,balanceMargin,fuelKg\n`;
      const body = vdRows
        .map((r) =>
          [r.value, r.lapTimeS, r.maxLatG, r.balanceMargin ?? "", r.fuelKg]
            .map((x) => (typeof x === "number" ? x.toFixed(6) : x))
            .join(","),
        )
        .join("\n");
      const stem = `helios-lapsim-vdsweep-${vdParam}-${slugify(sourceA.configName)}-${fileTimestamp()}`;
      const ok = await save(header + cols + body + "\n", `${stem}.csv`);
      setExportMsg(ok ? `Saved → ${stem}.csv` : "Cancelled");
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setExportMsg(null), 4000);
  }

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
      const stem = `helios-lapsim-${event}-${slugify(runA.source.configName)}-${fileTimestamp()}`;
      const ok = await save(csv, `${stem}.csv`);
      setExportMsg(ok ? `Saved → ${stem}.csv` : "Cancelled");
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
              disabled={vdMode}
              title={vdMode ? "VD-sweep mode compares against the swept vehicle (B = swept setup)" : undefined}
              className="max-w-[220px] rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none disabled:opacity-50"
              value={sourceB?.id ?? ""}
              onChange={(e) => setCompareId(e.target.value || null)}
            >
              <option value="">(none)</option>
              {sources.filter((s) => s.id !== sourceA?.id).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          {/* VD-sweep mode toggle — gates all VD additions; default A/B path is
              untouched when off. */}
          <button
            type="button"
            onClick={() => setVdMode((m) => !m)}
            aria-pressed={vdMode}
            title="Sweep one vehicle-dynamics knob (mass / CG / ARB balance / tire µ dropoff) on source A's engine"
            className={
              "rounded-sm border px-2 py-1 text-[10px] uppercase tracking-wider " +
              (vdMode
                ? "border-[#FFC627] bg-[#FFC627] font-semibold text-[#0E0E10]"
                : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]")
            }
          >
            VD sweep
          </button>
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
      </header>

      {exportMsg && (
        <div role="status" className="flex-shrink-0 border-b border-[#FFC627]/40 bg-[#16171B] px-3 py-1 text-[10px] text-[#D8DCE2]">
          {exportMsg}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!runA ? (
          <div className="m-4 rounded-sm border border-dashed border-[#2A2C32] p-8 text-center text-[11px] text-[#5A5F66]">
            No torque curve available. The lap sim drives the car with an engine sweep —
            import a dyno CSV or pull a sweep from CFD to supply one.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Headline stats (+ B row when comparing) */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <HeadlineRow tag="A" run={runA} accent />
              {runB && <HeadlineRow tag="B" run={runB} deltaVs={runA} />}
              <LimitBar run={runA} />
            </section>

            {/* VD sweep — vary one vehicle-dynamics knob across a range. The
                B-run above is the swept setup at the sweep STOP value. */}
            {vdMode && (
              <VdSweepPanel
                param={vdParam}
                onParam={selectVdParam}
                paramDisabled={vdParamDisabled}
                start={vdStart}
                stop={vdStop}
                step={vdStep}
                onStart={setVdStart}
                onStop={setVdStop}
                onStep={setVdStep}
                rows={vdRows}
                baselineValue={vdBaselineValue}
                rollPresent={rollPresent}
                onExport={() => void exportVdSweepCsv()}
              />
            )}

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
                            {LIMIT_LABEL[s]}
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
                    sectors={sectors}
                    secDeltas={secDeltas}
                    signedLatG={signedLatG}
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
                  latG={signedLatG ?? runA.ch.latG}
                  longG={runA.ch.longG}
                  limit={runA.ch.limit}
                  muLat={runA.vehicle.muLat}
                  muLong={runA.vehicle.muLong}
                  height={330}
                />
              </section>
            </div>

            {/* Corner-complex sectors (brake-application boundaries) */}
            {sectors.length > 1 && (
              <SectorTable sectors={sectors} deltas={secDeltas} runB={runB} />
            )}

            {/* Delta-T (compare mode) — require a non-empty trace so the
                `final … s` readout (deltaT[last]) can't deref an empty array. */}
            {runB && deltaT && deltaT.length > 0 && (
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
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <LinePlot
                title="pedal demand vs distance — A (demand ÷ capacity from the grip model; 100% = at the limit)"
                xs={runA.ch.distM}
                series={[
                  { label: "throttle (%)", y: runA.ch.throttle.map((f) => f * 100), color: "#A5D6A7", width: 1.5, showPoints: false },
                  { label: "brake (%)", y: runA.ch.brake.map((f) => f * 100), color: "#FF5252", width: 1.5, showPoints: false },
                  ...(runB
                    ? [{ label: "B throttle (%)", y: runA.ch.distM.map((d) => interpAt(runB.ch.distM, runB.ch.throttle, d) * 100), color: "#4FC3F7", width: 1, showPoints: false }]
                    : []),
                ]}
                xLabel="distance (m)"
                yLabel="%"
                height={220}
              />
              <p className="px-3 pb-2 text-[9px] leading-tight text-[#5A5F66]">
                Throttle pinned at 100% = power-limited (a bigger engine helps); below 100% while accelerating =
                traction-limited corner exit (the driver is metering). Brake at 100% = using every bit of grip.
              </p>
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
  runA, runB, visual, fracs, colors, sectors, secDeltas, signedLatG,
}: {
  runA: LapRun;
  runB: LapRun | null;
  visual: typeof AUTOCROSS_2026_VISUAL;
  fracs: number[];
  colors: string[];
  sectors: LapSector[];
  secDeltas: number[] | null;
  /** Direction-signed lateral g (from the traced layout) for the g-meter. */
  signedLatG: number[] | null;
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

  // Engine-internals interpolation tables — once per lap source, NOT inside
  // the per-frame cursor memo (sorting + remapping the sweep points 60×/s was
  // a real part of the playback lag).
  const engTables = useMemo(() => {
    const pts = [...runA.source.points].sort((a, b) => a.rpm - b.rpm);
    const maxOf = (ys: number[], fallback: number): number => {
      const m = Math.max(...ys.filter(Number.isFinite));
      return Number.isFinite(m) && m > 0 ? m : fallback;
    };
    const power = pts.map((p) => p.lastCycle.brakePowerKW ?? NaN);
    const ve = pts.map((p) => p.lastCycle.veAtm ?? NaN);
    const egt = pts.map((p) => p.lastCycle.egtMean ?? NaN);
    const bmep = pts.map((p) => p.lastCycle.bmepBar ?? NaN);
    return {
      rpms: pts.map((p) => p.rpm),
      power,
      ve,
      egt,
      ki: pts.map((p) => p.lastCycle.knockIntegral ?? NaN),
      bmep,
      // Gauge full-scale = THIS engine's actual maxima (hardcoded guesses
      // pinned the bars on any design that beat them).
      maxPower: maxOf(power, 55),
      maxVe: maxOf(ve, 1.3),
      maxEgt: maxOf(egt, 1300),
      maxBmep: maxOf(bmep, 13),
    };
  }, [runA.source.points]);

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
    const eng = (ys: number[]): number => interpAt(engTables.rpms, ys, rpm);
    const gear = chA.gear[i] ?? 0;
    const vMps = interpAt(chA.tS, chA.vMps, t);
    // Optimal-shift proximity: the dash shift light arms as the car closes on
    // THIS gear's force-crossover speed (the same schedule the solver drives).
    const shiftSpeed = gear >= 1 && gear - 1 < runA.shiftV.length ? runA.shiftV[gear - 1]! : Infinity;
    const sIdx = sectors.findIndex((s) => dist >= s.startM && dist < s.endM);
    return {
      dist,
      frac: dist / totalDist,
      speedKph: vMps * 3.6,
      rpm,
      gear,
      latG: interpAt(chA.tS, signedLatG ?? chA.latG, t),
      longG: interpAt(chA.tS, chA.longG, t),
      throttle: interpAt(chA.tS, chA.throttle, t),
      brake: interpAt(chA.tS, chA.brake, t),
      limit: chA.limit[i] ?? "coast",
      fuelG: interpAt(chA.tS, chA.fuelCumKg, t) * 1000,
      shiftFrac: Number.isFinite(shiftSpeed) && shiftSpeed > 0 ? vMps / shiftSpeed : 0,
      sector: sIdx >= 0 ? sIdx : sectors.length - 1,
      powerKw: eng(engTables.power),
      ve: eng(engTables.ve),
      egt: eng(engTables.egt),
      ki: eng(engTables.ki),
      bmep: eng(engTables.bmep),
    };
  }, [chA, t, totalDist, engTables, runA.shiftV, sectors, signedLatG]);

  // B's true position at the same instant (clamped to its own finish), plus
  // the live gap: when does B reach A's CURRENT piece of road (+ve = A ahead).
  const bState = useMemo(() => {
    if (!runB) return null;
    const chB = runB.ch;
    const dB = interpAt(chB.tS, chB.distM, Math.min(t, chB.tS[chB.tS.length - 1] ?? 0));
    const gapS = interpAt(chB.distM, chB.tS, cur.dist) - t;
    return { frac: dB / (chB.distM[chB.distM.length - 1] || 1), gapS };
  }, [runB, t, cur.dist]);
  const fracB = bState?.frac ?? null;

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
      {/* Dash — supersport LCD cluster: the rpm scale sweeps up from low-left
          and flattens across the top (Ninja-style), gear at left, big digital
          speed under the flat of the curve. */}
      {/* Race strip — live sector + gap context above the cluster. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[#16171B] bg-[#0B0B0D] px-3 pt-2">
        {sectors.length > 1 && (
          <>
            <span className="rounded-sm border border-[#FFC627]/40 bg-[#FFC627]/10 px-2 py-0.5 font-mono text-[10px] text-[#FFC627]">
              S{cur.sector + 1}
              <span className="text-[#9097A0]">/{sectors.length}</span>
            </span>
            {sectors[cur.sector] && (
              <span className="flex items-center gap-1 font-mono text-[9px] text-[#9097A0]">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: LIMIT_COLOR[sectors[cur.sector]!.dominant] }}
                />
                {LIMIT_LABEL[sectors[cur.sector]!.dominant]} sector · vmin{" "}
                {sectors[cur.sector]!.vMinKph.toFixed(0)} km/h
              </span>
            )}
            {secDeltas?.[cur.sector] != null && (
              <span
                className={
                  "font-mono text-[10px] tabular-nums " +
                  (secDeltas[cur.sector]! >= 0 ? "text-[#A5D6A7]" : "text-[#FF8A65]")
                }
                title="B's time over this sector minus A's (+ = A faster here)"
              >
                sector {secDeltas[cur.sector]! >= 0 ? "+" : ""}
                {secDeltas[cur.sector]!.toFixed(2)} s
              </span>
            )}
          </>
        )}
        {bState && (
          <span
            className={
              "ml-auto rounded-sm border px-2 py-0.5 font-mono text-[11px] tabular-nums " +
              (bState.gapS >= 0
                ? "border-[#A5D6A7]/40 bg-[#A5D6A7]/10 text-[#A5D6A7]"
                : "border-[#FF8A65]/40 bg-[#FF8A65]/10 text-[#FF8A65]")
            }
            title="Time until B reaches A's current track position (+ = A ahead)"
          >
            gap {bState.gapS >= 0 ? "+" : ""}{bState.gapS.toFixed(2)} s
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-4 bg-[#0B0B0D] px-3 py-2">
        <Cluster
          rpm={cur.rpm}
          revLimit={runA.vehicle.revLimitRpm}
          gear={cur.gear}
          speedKph={cur.speedKph}
          limit={cur.limit}
          shiftFrac={cur.shiftFrac}
        />
        <PedalBars throttle={cur.throttle} brake={cur.brake} />
        <GDot latG={cur.latG} longG={cur.longG} />
        {/* Engine vitals as mini bar gauges — full scale = this design's maxima */}
        <div className="grid min-w-[210px] flex-1 grid-cols-1 gap-1.5 sm:grid-cols-2">
          <BarGauge label="power" value={cur.powerKw} max={engTables.maxPower} unit="kW" color="#FFC627" />
          <BarGauge label="BMEP" value={cur.bmep} max={engTables.maxBmep} unit="bar" color="#4FC3F7" />
          <BarGauge label="VE" value={cur.ve * 100} max={engTables.maxVe * 100} unit="%" color="#A5D6A7" />
          <BarGauge label="EGT" value={cur.egt} min={600} max={engTables.maxEgt} unit="K" color="#FF8A65" />
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
        {/* No CSS transition: the player updates 60×/s, and a width transition
            keeps restarting against that and visibly trails the readout. */}
        <div
          className="h-full rounded-sm"
          style={{
            width: `${frac * 100}%`,
            background: `linear-gradient(to right, ${color}55, ${color})`,
            boxShadow: `0 0 6px ${color}66`,
          }}
        />
      </div>
      <span className="w-[64px] font-mono text-[10px] tabular-nums text-[#D8DCE2]">
        {ok ? `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}` : "—"}
      </span>
    </div>
  );
}

/** Vertical throttle/brake demand bars — telemetry-overlay style. Values are
 *  demand ÷ capacity from the sim's own grip model (1 = the friction or
 *  power limit), not a guessed pedal position. */
function PedalBars({ throttle, brake }: { throttle: number; brake: number }) {
  const H = 92;
  const bar = (label: string, frac: number, color: string) => {
    const f = Math.min(1, Math.max(0, frac));
    return (
      <div className="flex flex-col items-center gap-0.5">
        <div className="relative h-[64px] w-3.5 overflow-hidden rounded-sm border border-[#2A2C32] bg-[#101114]">
          <div
            className="absolute bottom-0 left-0 right-0"
            style={{
              height: `${f * 100}%`,
              background: `linear-gradient(to top, ${color}, ${color}88)`,
              boxShadow: `0 0 6px ${color}66`,
            }}
          />
          {/* full-demand tick */}
          <div className="absolute left-0 right-0 top-0 h-px bg-[#2A2C32]" />
        </div>
        <span className="font-mono text-[9px] tabular-nums text-[#D8DCE2]">{(f * 100).toFixed(0)}</span>
        <span className="text-[7px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      </div>
    );
  };
  return (
    <div className="flex items-end gap-1.5" style={{ height: H }} role="img"
      aria-label={`throttle ${(throttle * 100).toFixed(0)} percent, brake ${(brake * 100).toFixed(0)} percent`}>
      {bar("thr", throttle, "#A5D6A7")}
      {bar("brk", brake, "#FF5252")}
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

/** Supersport LCD cluster (Ninja-style): the rpm scale starts small at the
 *  lower-left and sweeps up along a curve that flattens across the top of
 *  the panel — a quarter-ellipse, using the full horizontal width. Gear
 *  indicator sits at the left, big digital speed under the flat of the
 *  curve, gradient band fills along the scale, redline numerals go red, and
 *  a shift light strobes at the limiter. */
function Cluster({
  rpm, revLimit, gear, speedKph, limit, shiftFrac = 0,
}: {
  rpm: number;
  revLimit: number;
  gear: number;
  speedKph: number;
  limit: LimitState;
  /** Speed ÷ this gear's optimal (force-crossover) shift speed: ≥1 = shift
   *  NOW for max force; ~0.97 arms the light. Drives the amber stage. */
  shiftFrac?: number;
}) {
  const maxRpm = Math.ceil(revLimit / 1000) * 1000;
  const W = 470;
  const H = 148;
  // Quarter-ellipse: center low-right, so θ 180° (low left) → 90° (top,
  // right of middle). Screen y is down: y = cy − ry·sinθ.
  const cx = W - 72;
  const cy = H - 12;
  const rx = W - 104;
  const ry = H - 44;
  const thetaOf = (r: number) =>
    ((180 - (Math.min(Math.max(r, 0), maxRpm) / maxRpm) * 90) * Math.PI) / 180;
  const pt = (r: number, off = 0): [number, number] => {
    const th = thetaOf(r);
    // offset outward along the (approximate) normal — away from the center
    const px = cx + rx * Math.cos(th);
    const py = cy - ry * Math.sin(th);
    const nx = px - cx;
    const ny = py - cy;
    const nl = Math.hypot(nx, ny) || 1;
    return [px + (nx / nl) * off, py + (ny / nl) * off];
  };
  const arc = (from: number, to: number) => {
    const [x0, y0] = pt(from);
    const [x1, y1] = pt(to);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rx} ${ry} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const redFrom = revLimit - 1500; // numerals go red approaching the limiter
  const atLimiter = rpm >= revLimit - 150;
  return (
    <svg
      width={W}
      height={H}
      role="img"
      aria-label={`Cluster: ${rpm.toFixed(0)} rpm, gear ${gear || "N"}, ${speedKph.toFixed(0)} km/h`}
      className="block rounded-md border border-[#2A2C32] bg-[#101114]"
    >
      <defs>
        <linearGradient id="swooshBand" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#4FC3F7" />
          <stop offset="55%" stopColor="#FFC627" />
          <stop offset="88%" stopColor="#FF8A65" />
          <stop offset="100%" stopColor="#FF5252" />
        </linearGradient>
      </defs>
      {/* scale track + live band */}
      <path d={arc(0, maxRpm)} fill="none" stroke="#1B1D22" strokeWidth={13} strokeLinecap="round" />
      <path d={arc(redFrom, maxRpm)} fill="none" stroke="#FF525233" strokeWidth={13} strokeLinecap="round" />
      {/* live band — butt cap so the leading edge is a clean straight cut
          (the band edge IS the rpm indicator; no separate cursor blade) */}
      <path
        d={arc(0, Math.max(80, rpm))}
        fill="none"
        stroke="url(#swooshBand)"
        strokeWidth={9}
        strokeLinecap="butt"
        opacity={0.95}
      />
      {/* ticks + numerals: minor 500, major 1000 (numerals like the bike: 1..14) */}
      {Array.from({ length: maxRpm / 500 + 1 }, (_, i) => {
        const r = i * 500;
        if (r === 0) return null;
        const major = r % 1000 === 0;
        const [x1, y1] = pt(r, 8);
        const [x2, y2] = pt(r, major ? 17 : 12);
        const red = r >= redFrom;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={red ? "#FF5252" : major ? "#9097A0" : "#3A3D44"} strokeWidth={major ? 2 : 1} />
            {major && (
              <text {...(() => { const [tx, ty] = pt(r, 27); return { x: tx, y: ty + 3 }; })()}
                fontSize={10} fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" fontWeight={red ? 700 : 400}
                fill={red ? "#FF5252" : "#9097A0"} textAnchor="middle">
                {r / 1000}
              </text>
            )}
          </g>
        );
      })}
      <text x={W - 8} y={14} fontSize={7.5} fill="#5A5F66" textAnchor="end"
        style={{ letterSpacing: 1 }}>
        ×1000 r/min
      </text>
      {/* Shift light, three stages: off → AMBER at ~97% of this gear's
          force-crossover speed (the optimal shift the solver drives — shift
          for force, not at redline) → strobing RED at the limiter. */}
      {(() => {
        const shiftNow = shiftFrac >= 0.97 && !atLimiter;
        const fill = atLimiter ? "#FF5252" : shiftNow ? "#FFC627" : "#1B1D22";
        const glow = atLimiter ? "#FF5252" : "#FFC627";
        return (
          <g>
            <circle cx={W - 16} cy={26} r={5} fill={fill}
              stroke={atLimiter || shiftNow ? glow : "#2A2C32"} strokeWidth={1}
              style={atLimiter || shiftNow ? { filter: `drop-shadow(0 0 5px ${glow})` } : undefined}>
              {atLimiter && <animate attributeName="opacity" values="1;0.2;1" dur="0.22s" repeatCount="indefinite" />}
            </circle>
            {shiftNow && (
              <text x={W - 16} y={42} fontSize={7} fill="#FFC627" textAnchor="middle"
                style={{ letterSpacing: 1 }}>
                SHIFT
              </text>
            )}
          </g>
        );
      })()}
      {/* GEAR — top-left corner (the scale starts low there, corner is free) */}
      <text x={12} y={16} fontSize={9} fill="#5A5F66" style={{ letterSpacing: 2 }}>
        GEAR
      </text>
      <text x={10} y={56} fontSize={42} fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" fontWeight={700}
        fill="#A5D6A7" style={{ textShadow: "0 0 12px #A5D6A766" }}>
        {gear || "N"}
      </text>
      {/* Right-side stack, centered under the flat of the curve:
          speed → km/h → limit chip, one shared centerline. */}
      {(() => {
        const rcx = W - 92; // centered in the open area right of the curve end
        return (
          <g>
            <text x={rcx} y={H - 44} fontSize={48} fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" fontWeight={700}
              fill="#FAFAFA" textAnchor="middle" style={{ textShadow: "0 0 10px #FFFFFF22" }}>
              {speedKph.toFixed(0)}
            </text>
            <text x={rcx} y={H - 30} fontSize={9} fill="#5A5F66" textAnchor="middle" style={{ letterSpacing: 2 }}>
              km/h
            </text>
            <rect x={rcx - 26} y={H - 24} width={52} height={16} rx={2}
              fill={`${LIMIT_COLOR[limit]}14`} stroke={`${LIMIT_COLOR[limit]}66`} strokeWidth={1} />
            <text x={rcx} y={H - 13} fontSize={8} fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" fill={LIMIT_COLOR[limit]} textAnchor="middle">
              {LIMIT_LABEL[limit].toUpperCase()}
            </text>
          </g>
        );
      })()}
      {/* rpm digital, lower-left under the rising scale */}
      <text x={120} y={H - 26} fontSize={15} fontFamily="'JetBrains Mono Variable', ui-monospace, monospace" fill="#D8DCE2" textAnchor="middle" fontWeight={700}>
        {rpm.toFixed(0)}
      </text>
      <text x={120} y={H - 14} fontSize={7} fill="#5A5F66" textAnchor="middle" style={{ letterSpacing: 1.5 }}>
        RPM
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
  { key: "throttle", label: "throttle demand", unit: "%" },
  { key: "brake", label: "brake demand", unit: "%" },
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
    case "throttle": return ch.throttle.map((f) => f * 100);
    case "brake": return ch.brake.map((f) => f * 100);
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
        {LIMIT_LABEL[s]}
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

/** VD-sweep control panel + "lap time vs swept value" plot (roadmap #13). Pure
 *  presentational: the parent owns the sweep state + the runVdSweep result. The
 *  swept value at `stop` is what the A/B comparison above uses as B. */
function VdSweepPanel({
  param, onParam, paramDisabled,
  start, stop, step, onStart, onStop, onStep,
  rows, baselineValue, rollPresent, onExport,
}: {
  param: VdParam;
  onParam: (p: VdParam) => void;
  paramDisabled: (p: VdParam) => boolean;
  start: number; stop: number; step: number;
  onStart: (n: number) => void; onStop: (n: number) => void; onStep: (n: number) => void;
  rows: VdSweepRow[];
  baselineValue: number | null;
  rollPresent: boolean;
  onExport: () => void;
}) {
  const meta = VD_PARAM_META[param];
  const disabled = paramDisabled(param);
  const xs = rows.map((r) => r.value);
  const lapY = rows.map((r) => r.lapTimeS);
  // Baseline "you are here" marker: a thin vertical series at the resolved
  // baseline value, spanning the lap-time range so it reads as a reference line.
  const yLo = lapY.length ? Math.min(...lapY) : 0;
  const yHi = lapY.length ? Math.max(...lapY) : 1;
  const fastest = rows.length ? rows.reduce((a, b) => (b.lapTimeS < a.lapTimeS ? b : a)) : null;
  const inputCls =
    "w-20 rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none";

  return (
    <section className="rounded-sm border border-[#FFC627]/30 bg-[#0E0E10]">
      <div className="flex flex-wrap items-end gap-3 border-b border-[#2A2C32] px-3 py-2">
        <span className="pb-1.5 text-[10px] uppercase tracking-wider text-[#FFC627]">VD sweep</span>
        <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">
          parameter
          <select
            aria-label="VD sweep parameter"
            title={
              rollPresent
                ? "CG-height sweeps need the quasi-steady-state model (roadmap): on the current roll model, CG changes only longitudinal load transfer, so the lap trend would be misleading. Available on lumped-model vehicles."
                : undefined
            }
            className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
            value={param}
            onChange={(e) => onParam(e.target.value as VdParam)}
          >
            {VD_PARAMS.map((p) => (
              <option key={p} value={p} disabled={paramDisabled(p)}>
                {VD_PARAM_META[p].label}
                {paramDisabled(p) ? (p === "cgHeightM" ? " (roll model)" : " (.tir)") : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">
          start
          <input type="number" aria-label="VD sweep start" className={inputCls} value={start} step={step}
            onChange={(e) => onStart(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">
          stop (= B)
          <input type="number" aria-label="VD sweep stop" className={inputCls} value={stop} step={step}
            onChange={(e) => onStop(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">
          step
          <input type="number" aria-label="VD sweep step" className={inputCls} value={step} step={step}
            onChange={(e) => onStep(Number(e.target.value) || step)} />
        </label>
        <span className="pb-1.5 text-[9px] text-[#5A5F66]">{meta.unit}</span>
        <button
          type="button"
          onClick={onExport}
          disabled={rows.length === 0}
          title="Export the sweep summary (value, lapTimeS, maxLatG, balanceMargin, fuelKg) as CSV"
          className="ml-auto rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627] disabled:opacity-50"
        >
          Export sweep CSV
        </button>
      </div>
      {disabled ? (
        <div className="px-3 py-4 text-[10px] text-[#FF8A65]">
          {param === "cgHeightM" ? (
            <>
              CG-height sweeps need the quasi-steady-state model (roadmap): on the current roll model, CG changes only
              longitudinal load transfer, so the lap trend would be misleading. Available on lumped-model vehicles —
              pick mass, ARB balance, or µ-dropoff.
            </>
          ) : (
            <>
              A measured tire model (.tir) overrides µ(Fz), so the µ-dropoff sweep is disabled — pick mass, CG height,
              or ARB balance, or remove the tire model in Performance.
            </>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-4 text-[10px] text-[#5A5F66]">No sweep points — check the start/stop/step range.</div>
      ) : (
        <>
          <LinePlot
            title={`lap time vs ${meta.label} — fastest ${fastest!.lapTimeS.toFixed(2)} s @ ${fastest!.value.toFixed(param === "cgHeightM" || param === "rsdFront" ? 3 : 1)} ${meta.unit}`}
            xs={xs}
            series={[
              { label: "lap time (s)", y: lapY, color: "#FFC627", width: 2, showPoints: true },
              ...(baselineValue != null
                ? [{ label: "baseline", xs: [baselineValue, baselineValue], y: [yLo, yHi], color: "#4FC3F7", width: 1, showPoints: false }]
                : []),
            ]}
            xLabel={`${meta.label} (${meta.unit})`}
            yLabel="lap time (s)"
            height={240}
          />
          <p className="px-3 pb-2 text-[9px] leading-tight text-[#5A5F66]">
            Source A&apos;s engine on the swept vehicle; everything else held. Blue line = the current resolved baseline.
            The A/B headline + traces above compare baseline (A) vs the swept setup at the STOP value (B).
            {param === "rsdFront" && " A balance sweet spot shows as a lap-time minimum, not a monotone trend."}
          </p>
        </>
      )}
    </section>
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
      <Stat label="brake E" value={`${tm.brakeEnergyKJ.toFixed(0)} kJ`} />
      <Stat label="pk brake" value={`${tm.peakBrakePowerKw.toFixed(0)} kW`} />
      <Stat label="tire duty" value={`${tm.tireDutyGkm.toFixed(2)} g·km`} />
      <Stat label="power-limited" value={`${(tm.pctPowerLimited * 100).toFixed(0)}%`} highlight />
    </div>
  );
}

/** Corner-complex sector table (roadmap #10): one row per brake-application
 *  sector — time, apex speed, limit-state makeup, and B's time over the same
 *  road when comparing. The worst (most time lost) sector is flagged. */
function SectorTable({ sectors, deltas, runB }: {
  sectors: LapSector[];
  deltas: number[] | null;
  runB: LapRun | null;
}) {
  // Most-negative delta = where A loses the most to B (or, without B, the
  // slowest sector by time share is simply visible from the bars).
  const worstIdx = deltas
    ? deltas.reduce((w, d, i) => (d < deltas[w]! ? i : w), 0)
    : -1;
  const bestIdx = deltas
    ? deltas.reduce((b, d, i) => (d > deltas[b]! ? i : b), 0)
    : -1;
  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">
          Sectors — corner complexes (split at brake applications)
        </span>
        <span className="text-[9px] text-[#5A5F66]">
          {runB ? "ΔB = B − A over the same road; green = A faster there" : "compare a B lap to see per-sector time deltas"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[10px] tabular-nums">
          <thead>
            <tr className="border-b border-[#2A2C32] text-[8px] uppercase tracking-wider text-[#5A5F66]">
              <th className="px-3 py-1.5 text-left">sector</th>
              <th className="px-2 py-1.5 text-right">from–to (m)</th>
              <th className="px-2 py-1.5 text-right">time (s)</th>
              {deltas && <th className="px-2 py-1.5 text-right">ΔB (s)</th>}
              <th className="px-2 py-1.5 text-right">vmin</th>
              <th className="px-2 py-1.5 text-right">vmax</th>
              <th className="px-2 py-1.5 text-left">limited by</th>
              <th className="w-[30%] px-3 py-1.5 text-left">time makeup</th>
            </tr>
          </thead>
          <tbody>
            {sectors.map((s, i) => {
              const d = deltas?.[i];
              const tag = i === worstIdx && d != null && d < 0 ? "▼" : i === bestIdx && d != null && d > 0 ? "▲" : "";
              return (
                <tr key={s.idx} className="border-b border-[#16171B] text-[#D8DCE2] hover:bg-[#16171B]">
                  <td className="px-3 py-1 text-[#FFC627]">
                    S{s.idx} {tag && <span className={d! < 0 ? "text-[#FF8A65]" : "text-[#A5D6A7]"}>{tag}</span>}
                  </td>
                  <td className="px-2 py-1 text-right text-[#9097A0]">
                    {s.startM.toFixed(0)}–{s.endM.toFixed(0)}
                  </td>
                  <td className="px-2 py-1 text-right">{s.timeS.toFixed(2)}</td>
                  {deltas && (
                    <td className={"px-2 py-1 text-right " + (d == null ? "" : d >= 0 ? "text-[#A5D6A7]" : "text-[#FF8A65]")}>
                      {d == null ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(2)}`}
                    </td>
                  )}
                  <td className="px-2 py-1 text-right">{s.vMinKph.toFixed(0)}</td>
                  <td className="px-2 py-1 text-right">{s.vMaxKph.toFixed(0)}</td>
                  <td className="px-2 py-1">
                    <span
                      className="rounded-sm border px-1.5 py-px text-[8px] uppercase"
                      style={{
                        color: LIMIT_COLOR[s.dominant],
                        borderColor: `${LIMIT_COLOR[s.dominant]}66`,
                        background: `${LIMIT_COLOR[s.dominant]}14`,
                      }}
                    >
                      {LIMIT_LABEL[s.dominant]}
                    </span>
                  </td>
                  <td className="px-3 py-1">
                    <div className="flex h-2 w-full overflow-hidden rounded-sm border border-[#2A2C32]">
                      {(Object.entries(s.limitFrac) as [LimitState, number][])
                        .sort((a, b) => b[1] - a[1])
                        .map(([state, frac]) => (
                          <div
                            key={state}
                            style={{ width: `${frac * 100}%`, background: LIMIT_COLOR[state] }}
                            title={`${LIMIT_LABEL[state]}: ${(frac * 100).toFixed(0)}%`}
                          />
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-1.5 text-[9px] leading-tight text-[#5A5F66]">
        A sector = one braking zone + the corner it serves + the run to the next braking zone — the unit a race
        engineer reasons in. ▼ marks where A loses the most time to B, ▲ where A gains the most.
      </p>
    </section>
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
            title={`${LIMIT_LABEL[state]}: ${(frac * 100).toFixed(0)}% of lap time`}
            className="flex items-center justify-center font-mono text-[7px] text-black/70"
          >
            {frac >= 0.09 ? `${LIMIT_LABEL[state]} ${(frac * 100).toFixed(0)}%` : ""}
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
