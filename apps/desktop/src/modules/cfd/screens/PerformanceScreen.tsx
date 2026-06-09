// Performance screen (P1): turns a study's torque curve into FSAE-relevant
// vehicle numbers — the tractive-effort map, the 75 m acceleration event, and
// the skidpad gear/RPM readout — under an editable VehicleConfig. All scoring is
// frontend math (see cfd/lib/performance); the source torque curve comes from a
// completed sweep or an optimization trial's stored sweepPoints.

import { useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { LinePlot, type LineSeries } from "../components/charts/LinePlot";
import { TrackLayout } from "../components/charts/TrackLayout";
import { buildDesignReportHtml } from "../lib/export/designReport";
import { saveTextFile, fileTimestamp, slugify } from "../lib/export/io";
import {
  carKeyForConfig,
  vehiclePresetForKey,
  vehicleForCar,
  torqueCurveFromSweep,
  peakTorque,
  topSpeedMps,
  tractiveMap,
  simAccel,
  skidpad,
  computeEvents,
  AUTOCROSS_2026,
  ENDURANCE_2026,
  AUTOCROSS_2026_VISUAL,
  ENDURANCE_2026_VISUAL,
  REFERENCE_2026,
  trackLength,
  TIGHTNESS_COLOR,
  sweepFinalDrive,
  comboLabel,
  type FdSweepRow,
  type TorqueCurve,
  type VehicleConfig,
  type ReferenceBaseline,
  type EventScores,
  type LapTelemetry,
} from "../lib/performance";
import { sourcesFrom } from "../lib/curveSources";

const GEAR_COLORS = ["#FFC627", "#4FC3F7", "#A5D6A7", "#F48FB1", "#CE93D8", "#FF8A65"];

// The lap sim scores against the real 2026 courses (see lib/performance/tracks).
const AX_LEN_M = trackLength(AUTOCROSS_2026);
const EN_LEN_KM = trackLength(ENDURANCE_2026) / 1000;

export function PerformanceScreen() {
  const { state, navigateTo, setVehicleConfig, setReferenceBaseline } = useCfd();
  const baseline = state.referenceBaseline;

  const sources = useMemo(() => sourcesFrom(state.studies), [state.studies]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skidpadTime, setSkidpadTime] = useState(4.9);
  const [editorOpen, setEditorOpen] = useState(false);

  const selected = sources.find((s) => s.id === selectedId) ?? sources[0] ?? null;
  // The vehicle (esp. final drive) auto-matches the loaded config: an SDM25
  // config uses the SDM25 preset (3.5 final drive), SDM26 uses 3.0. Edits to the
  // active car stick; selecting a different car shows that car's preset.
  const carKey = selected ? carKeyForConfig(selected.configName) : "SDM26";
  // Car-identity (mass, final drive, gearing) is forced from the preset for a
  // known car — SDM25 is always 281 kg / 3.5 FD, SDM26 267 kg / 3.0 FD — so it
  // can't be thrown off by stale persisted state. User tuning (grip/aero) is kept.
  const vehicle = vehicleForCar(carKey, state.vehicleConfig);
  const curve = useMemo(
    () => (selected ? torqueCurveFromSweep(selected.points) : []),
    [selected],
  );

  const tractive = useMemo(
    () => (curve.length ? tractiveMap(curve, vehicle) : null),
    [curve, vehicle],
  );
  const accel = useMemo(
    () => (curve.length ? simAccel(curve, vehicle) : null),
    [curve, vehicle],
  );
  const skid = useMemo(() => skidpad(vehicle, skidpadTime), [vehicle, skidpadTime]);
  const events = useMemo(
    () => (curve.length ? computeEvents(curve, vehicle, baseline) : null),
    [curve, vehicle, baseline],
  );
  const peak = useMemo(() => peakTorque(curve), [curve]);

  const [reportMsg, setReportMsg] = useState<string | null>(null);
  async function exportReport() {
    if (!selected || curve.length === 0) return;
    try {
      const html = buildDesignReportHtml({
        configName: selected.configName,
        generatedAt: new Date().toISOString(),
        vehicle,
        events,
        accel,
        skid,
        tractive,
        peak,
        autocross: AUTOCROSS_2026_VISUAL,
        endurance: ENDURANCE_2026_VISUAL,
      });
      const stem = `cfd-design-review-${slugify(selected.configName)}-${fileTimestamp()}`;
      const path = await saveTextFile(stem, "html", html);
      setReportMsg(path == null ? "Cancelled" : `Saved → ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setReportMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setReportMsg(null), 4000);
  }

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Performance</div>
          <p className="text-[10px] text-[#5A5F66]">
            {vehicle.name} · FD {vehicle.finalDrive.toFixed(2)} · {vehicle.massKg.toFixed(0)} kg ·{" "}
            {peak ? `peak τ ${peak.torqueNm.toFixed(1)} Nm @ ${peak.rpm.toFixed(0)}` : "no torque curve"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#9097A0]">
          Source
          <select
            aria-label="Torque-curve source"
            className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {sources.length === 0 && <option value="">(no studies)</option>}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setEditorOpen((v) => !v)}
          className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
        >
          {editorOpen ? "Hide vehicle" : "Vehicle setup"}
        </button>
        <button
          type="button"
          onClick={() => void exportReport()}
          disabled={!selected || curve.length === 0}
          title="Export a light-theme one-pager (HTML) for a design review — prints to PDF"
          className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627] disabled:opacity-50"
        >
          Export report
        </button>
      </header>

      {reportMsg && (
        <div role="status" className="flex-shrink-0 border-b border-[#FFC627]/40 bg-[#16171B] px-3 py-1 text-[10px] text-[#D8DCE2]">
          {reportMsg}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {editorOpen && (
          <VehicleEditor
            vehicle={vehicle}
            onChange={setVehicleConfig}
            resetTo={vehiclePresetForKey(carKey)}
          />
        )}

        {!selected || curve.length === 0 ? (
          <div className="m-4 rounded-sm border border-dashed border-[#2A2C32] p-8 text-center text-[11px] text-[#5A5F66]">
            No torque curve available. Run a sweep or an optimization, then come back —
            this screen reads the engine torque curve from a completed study.
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
            <EventsSection events={events} baseline={baseline} onBaseline={setReferenceBaseline} />

            {events && <TelemetrySection events={events} />}

            <FdOptimizerSection curve={curve} vehicle={vehicle} baseline={baseline} />

            {/* Track overview — the real 2026 course layouts, side by side. */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Track overview</span>
                <div className="flex items-center gap-2 text-[8px] uppercase tracking-wider text-[#5A5F66]">
                  {(["straight", "open", "medium", "tight", "hairpin"] as const).map((t) => (
                    <span key={t} className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-2.5 rounded-sm" style={{ background: TIGHTNESS_COLOR[t] }} />
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
                <div className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D]">
                  <TrackLayout track={AUTOCROSS_2026_VISUAL} />
                </div>
                <div className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D]">
                  <TrackLayout track={ENDURANCE_2026_VISUAL} />
                </div>
              </div>
              <p className="px-3 pb-2 text-[9px] leading-tight text-[#5A5F66]">
                Real traced 2026 layouts (display only — the lap sim integrates the radius profile, not these).
                Centerline colored by local corner tightness; the surface is the ~3.5 m course width.
              </p>
            </section>

            {/* Tractive-effort map */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              {tractive && (
                <LinePlot
                  title="tractive effort vs speed"
                  xs={tractive.speedsMps.map((v) => v * 3.6)}
                  series={tractiveSeries(tractive)}
                  xLabel="km/h"
                  yLabel="N"
                  height={360}
                />
              )}
            </section>

            {/* Acceleration */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[#2A2C32] px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Acceleration (75 m)</span>
                <Stat label="time" value={accel ? `${accel.timeS.toFixed(3)} s` : "—"} highlight />
                <Stat label="trap" value={accel ? `${(accel.trapSpeedMps * 3.6).toFixed(1)} km/h` : "—"} />
                <Stat label="finish" value={accel ? `gear ${accel.finishGear}` : "—"} />
              </div>
              {accel && accel.shiftPoints.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-[#2A2C32] px-3 py-1.5 text-[10px]">
                  <span className="uppercase tracking-wider text-[#5A5F66]">shift points</span>
                  {accel.shiftPoints.map((sp, i) => (
                    <span
                      key={i}
                      className="rounded-sm border border-[#FFC627]/40 px-1.5 py-0.5 font-mono text-[#FFC627]"
                      title={`lands at ${sp.landRpm.toFixed(0)} rpm in gear ${sp.toGear}, ${sp.distanceM.toFixed(1)} m`}
                    >
                      {sp.fromGear}→{sp.toGear} @ {(sp.speedMps * 3.6).toFixed(0)} km/h · {sp.shiftRpm.toFixed(0)} rpm
                    </span>
                  ))}
                  <span className="text-[#5A5F66]">· finish in gear {accel.finishGear}</span>
                </div>
              )}
              {accel && (
                <LinePlot
                  title="launch — speed & rpm vs distance"
                  xs={accel.trace.map((s) => s.x)}
                  series={[
                    { label: "speed (km/h)", y: accel.trace.map((s) => s.v * 3.6), color: "#4FC3F7" },
                    { label: "rpm", y: accel.trace.map((s) => s.rpm), color: "#FFC627", axis: "y2" },
                  ]}
                  xLabel="distance (m)"
                  yLabel="km/h"
                  y2Label="rpm"
                  height={300}
                />
              )}
              {accel && !accel.finished && (
                <p className="px-3 pb-2 text-[10px] text-amber-300">
                  Did not reach 75 m within the time limit — check gearing / torque curve.
                </p>
              )}
            </section>

            {/* Skidpad gear/RPM readout */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[#2A2C32] px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Skidpad gear / rpm</span>
                <label className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[#5A5F66]">
                  target time (s)
                  <input
                    type="number"
                    step={0.01}
                    value={skidpadTime}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n) && n > 0) setSkidpadTime(n);
                    }}
                    className="w-16 rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1.5 py-0.5 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
                  />
                </label>
                <Stat label="radius" value={`${skid.radiusM.toFixed(2)} m`} />
                <Stat label="speed" value={`${skid.speedKph.toFixed(1)} km/h`} highlight />
                <Stat label="lateral" value={`${skid.lateralG.toFixed(2)} g`} />
              </div>
              <div className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-6">
                {skid.perGear.map((g) => {
                  const inBand = g.rpm <= vehicle.revLimitRpm && g.rpm >= 0.5 * vehicle.shiftRpm;
                  return (
                    <div
                      key={g.gear}
                      className={
                        "rounded-sm border px-2 py-1.5 text-center " +
                        (inBand ? "border-[#FFC627]/50 bg-[#FFC627]/5" : "border-[#2A2C32]")
                      }
                    >
                      <div className="text-[9px] uppercase tracking-wider text-[#5A5F66]">gear {g.gear}</div>
                      <div className="font-mono text-[13px] text-[#D8DCE2]">{g.rpm.toFixed(0)}</div>
                      <div className="text-[8px] text-[#5A5F66]">rpm</div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function tractiveSeries(tractive: NonNullable<ReturnType<typeof tractiveMap>>): LineSeries[] {
  const gears: LineSeries[] = tractive.perGearForce.map((y, i) => ({
    label: `g${i + 1}`,
    y,
    color: GEAR_COLORS[i % GEAR_COLORS.length],
    width: 1,
    showPoints: false,
  }));
  return [
    ...gears,
    { label: "envelope", y: tractive.envelopeForce, color: "#FAFAFA", width: 2, showPoints: false },
    {
      label: "traction limit",
      y: tractive.tractionLimit,
      color: "#FF6B6B",
      width: 1,
      showPoints: false,
    },
    { label: "drag + roll", y: tractive.resistance, color: "#5A5F66", width: 1, showPoints: false },
  ];
}

function ptsStr(p: number | null): string {
  return p != null ? p.toFixed(1) : "—";
}

/** Model-predicted lap telemetry for autocross + endurance, side by side. Pulls
 *  everything the 2D sim now exposes: avg/max RPM, shift count, peak g's, time
 *  on throttle, top/avg speed, and a per-gear time-usage bar. */
function TelemetrySection({ events }: { events: EventScores }) {
  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">Lap telemetry — model predictions</span>
        <span className="text-[9px] text-[#5A5F66]">gear-explicit QSS sim</span>
      </div>
      <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
        <TelemetryCard label="Autocross" lapTimeS={events.autocross.lapTimeS} tm={events.autocross.telemetry} />
        <TelemetryCard label="Endurance" lapTimeS={events.endurance.lapTimeS} tm={events.endurance.telemetry} perLap />
      </div>
    </section>
  );
}

function TelemetryCard({
  label, lapTimeS, tm, perLap,
}: {
  label: string;
  lapTimeS: number;
  tm: LapTelemetry;
  perLap?: boolean;
}) {
  return (
    <div className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] p-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wider text-[#D8DCE2]">{label}</span>
        <span className="font-mono text-[12px] text-[#FFC627]">
          {lapTimeS.toFixed(2)} s{perLap ? "/lap" : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        <Stat label="avg rpm" value={tm.avgRpm.toFixed(0)} highlight />
        <Stat label="max rpm" value={tm.maxRpm.toFixed(0)} />
        <Stat label="shifts" value={String(tm.shiftCount)} />
        <Stat label="top spd" value={`${tm.vMaxKph.toFixed(0)} km/h`} />
        <Stat label="min spd" value={`${tm.vMinKph.toFixed(0)} km/h`} />
        <Stat label="on throttle" value={`${(tm.pctOnThrottle * 100).toFixed(0)}%`} />
        <Stat label="power-ltd" value={`${(tm.pctPowerLimited * 100).toFixed(0)}%`} highlight />
        <Stat label="corner-ltd" value={`${(tm.pctCornerLimited * 100).toFixed(0)}%`} />
        <Stat label="max lat" value={`${tm.maxLatG.toFixed(2)} g`} />
        <Stat label="max accel" value={`${tm.maxAccelG.toFixed(2)} g`} />
        <Stat label="max brake" value={`${tm.maxBrakeG.toFixed(2)} g`} />
      </div>
      <GearUsageBar frac={tm.timeInGearFrac} />
    </div>
  );
}

/** Horizontal stacked bar of time spent in each gear (colored g1…gN). */
function GearUsageBar({ frac }: { frac: number[] }) {
  const total = frac.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="mt-2.5">
      <div className="mb-1 text-[8px] uppercase tracking-wider text-[#5A5F66]">time in gear</div>
      <div className="flex h-3 w-full overflow-hidden rounded-sm border border-[#2A2C32]">
        {frac.map((f, i) => {
          const pct = (f / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={i}
              style={{ width: `${pct}%`, background: GEAR_COLORS[i % GEAR_COLORS.length] }}
              title={`gear ${i + 1}: ${pct.toFixed(0)}% of lap time`}
              className="flex items-center justify-center text-[7px] font-mono text-black/70"
            >
              {pct >= 9 ? i + 1 : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventsSection({
  events,
  baseline,
  onBaseline,
}: {
  events: EventScores | null;
  baseline: ReferenceBaseline;
  onBaseline: (b: ReferenceBaseline) => void;
}) {
  const set = (patch: Partial<ReferenceBaseline>) => onBaseline({ ...baseline, ...patch });
  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">FSAE events — projected</span>
        <button
          type="button"
          onClick={() => onBaseline(REFERENCE_2026)}
          className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[9px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
        >
          Load 2026 reference
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 border-b border-[#2A2C32] p-3 sm:grid-cols-4">
        <BaselineField label="accel Tmin (s)" value={baseline.accelTMin} onChange={(n) => set({ accelTMin: n })} />
        <BaselineField label="autocross Tmin (s)" value={baseline.autocrossTMin} onChange={(n) => set({ autocrossTMin: n })} />
        <BaselineField label="enduro Tmin/lap (s)" value={baseline.enduranceTMin} onChange={(n) => set({ enduranceTMin: n })} />
        <BaselineField label="CO₂ min/lap (kg)" value={baseline.co2MinPerLap} onChange={(n) => set({ co2MinPerLap: n })} />
        <BaselineField label="CO₂ cap/lap (kg)" value={baseline.co2MaxPerLap} onChange={(n) => set({ co2MaxPerLap: n })} />
        <BaselineField label="EF min (field)" value={baseline.effMin ?? null} onChange={(n) => set({ effMin: n })} />
        <BaselineField label="EF max (field)" value={baseline.effMax ?? null} onChange={(n) => set({ effMax: n })} />
      </div>
      {events ? (
        <>
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-[#0B0B0D] text-[9px] uppercase tracking-wider text-[#5A5F66]">
              <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
                <th>event</th>
                <th>sim metric</th>
                <th className="text-right">proj. points</th>
              </tr>
            </thead>
            <tbody className="[&>tr]:border-t [&>tr]:border-[#16171B] [&>tr>td]:px-3 [&>tr>td]:py-1.5">
              <tr>
                <td className="text-[#9097A0]">Acceleration</td>
                <td>{events.accel.timeS.toFixed(3)} s</td>
                <td className="text-right text-[#D8DCE2]">{ptsStr(events.accel.points)} <span className="text-[#5A5F66]">/ 100</span></td>
              </tr>
              <tr>
                <td className="text-[#9097A0]">Autocross</td>
                <td>{events.autocross.lapTimeS.toFixed(2)} s/lap</td>
                <td className="text-right text-[#D8DCE2]">{ptsStr(events.autocross.points)} <span className="text-[#5A5F66]">/ 125</span></td>
              </tr>
              <tr>
                <td className="text-[#9097A0]">Endurance</td>
                <td>
                  {events.endurance.lapTimeS.toFixed(2)} s/lap ·{" "}
                  {(events.endurance.co2KgPerLap * 1000).toFixed(0)} g CO₂/lap
                </td>
                <td className="text-right text-[#D8DCE2]">{ptsStr(events.endurance.points)} <span className="text-[#5A5F66]">/ 275</span></td>
              </tr>
              <tr>
                <td className="text-[#9097A0]">Efficiency</td>
                <td>factor {events.efficiency.factor != null ? events.efficiency.factor.toFixed(3) : "—"}</td>
                <td className="text-right text-[#D8DCE2]">{ptsStr(events.efficiency.points)} <span className="text-[#5A5F66]">/ 100</span></td>
              </tr>
              <tr className="bg-[#16171B]">
                <td className="text-[#D8DCE2]">Total (modeled)</td>
                <td className="text-[#5A5F66]">skidpad not modeled</td>
                <td className="text-right text-[13px] text-[#FFC627]">
                  {events.totalPoints != null ? events.totalPoints.toFixed(1) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="px-3 py-2 text-[10px] text-[#5A5F66]">
            Autocross 2026 ({AX_LEN_M.toFixed(0)} m, flat-out) and Endurance 2026 ({EN_LEN_KM.toFixed(2)} km/lap, race-paced) — real 2026 layouts. Model calibrated to SDM26's autocross (42.9 s) and the field's endurance/efficiency (Mines CBR600RR/E85). Lap times are estimates; points project against the 2026 field anchors above.
          </p>
        </>
      ) : (
        <p className="p-4 text-[11px] text-[#5A5F66]">Select a study with a torque curve.</p>
      )}
    </section>
  );
}

function BaselineField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-[#5A5F66]">{label}</span>
      <input
        type="number"
        step={0.01}
        value={value ?? ""}
        placeholder="—"
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : null);
        }}
        className="w-full rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
      />
    </label>
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

function VehicleEditor({
  vehicle,
  onChange,
  resetTo,
}: {
  vehicle: VehicleConfig;
  onChange: (v: VehicleConfig) => void;
  resetTo: VehicleConfig;
}) {
  const set = (patch: Partial<VehicleConfig>) => onChange({ ...vehicle, ...patch });

  return (
    <section className="mb-3 rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Vehicle setup — {vehicle.name}</span>
        <button
          type="button"
          onClick={() => onChange(resetTo)}
          className="rounded-sm border border-[#2A2C32] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
        >
          Reset to {resetTo.name}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4 lg:grid-cols-6">
        <NumField label="mass" unit="kg" value={vehicle.massKg} step={1} onChange={(n) => set({ massKg: n })} />
        <NumField label="front wt" value={vehicle.weightDistFront} step={0.01} onChange={(n) => set({ weightDistFront: n })} />
        <NumField label="μ long" value={vehicle.muLong} step={0.05} onChange={(n) => set({ muLong: n })} />
        <NumField label="μ lat" value={vehicle.muLat} step={0.05} onChange={(n) => set({ muLat: n })} />
        <NumField label="tire load sens" value={vehicle.tireLoadSensitivity} step={0.01} onChange={(n) => set({ tireLoadSensitivity: n })} />
        <NumField label="CdA" unit="m²" value={vehicle.cdaM2} step={0.01} onChange={(n) => set({ cdaM2: n })} />
        <NumField label="ρ air" unit="kg/m³" value={vehicle.airDensityKgM3} step={0.01} onChange={(n) => set({ airDensityKgM3: n })} />
        <NumField label="Crr" value={vehicle.crr} step={0.005} onChange={(n) => set({ crr: n })} />
        <NumField label="driveline η" value={vehicle.drivetrainEff} step={0.01} onChange={(n) => set({ drivetrainEff: n })} />
        <NumField label="track" unit="m" value={vehicle.trackWidthM} step={0.01} onChange={(n) => set({ trackWidthM: n })} />
        <NumField label="wheelbase" unit="m" value={vehicle.wheelbaseM} step={0.01} onChange={(n) => set({ wheelbaseM: n })} />
        <NumField label="shift" unit="rpm" value={vehicle.shiftRpm} step={100} onChange={(n) => set({ shiftRpm: n })} />
        <NumField label="rev limit" unit="rpm" value={vehicle.revLimitRpm} step={100} onChange={(n) => set({ revLimitRpm: n })} />
        <NumField label="shift time" unit="s" value={vehicle.shiftTimeS} step={0.01} onChange={(n) => set({ shiftTimeS: n })} />
      </div>
      <div className="border-t border-[#2A2C32] px-3 py-2">
        <div className="mb-2 flex flex-wrap items-end gap-3">
          <NumField label="final drive" value={vehicle.finalDrive} step={0.05} onChange={(n) => set({ finalDrive: n })} />
          <NumField label="primary" value={vehicle.primaryReduction} step={0.001} onChange={(n) => set({ primaryReduction: n })} />
          <NumField label="tire r" unit="m" value={vehicle.tireRadiusM} step={0.005} onChange={(n) => set({ tireRadiusM: n })} />
          <span className="pb-1.5 text-[9px] uppercase tracking-wider text-[#5A5F66]">
            top {(topSpeedMps(vehicle) * 3.6).toFixed(0)} km/h
          </span>
        </div>
        <div className="mb-1 text-[9px] uppercase tracking-wider text-[#5A5F66]">gearbox ratios (1st → top)</div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {vehicle.gearRatios.map((r, i) => (
            <NumField
              key={i}
              label={`g${i + 1}`}
              value={r}
              step={0.001}
              onChange={(val) =>
                set({ gearRatios: vehicle.gearRatios.map((rr, j) => (j === i ? val : rr)) })
              }
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
  unit,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-[#5A5F66]">
        {label}
        {unit ? ` (${unit})` : ""}
      </span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-full rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
      />
    </label>
  );
}

// ---- Final-drive (sprocket) optimizer ---------------------------------------
// Roadmap #1: gap attribution showed FD dominates endurance while a sprocket
// swap is the cheapest hardware change. Sweeps every real tooth combination
// through computeEvents (interactive post vCorner-memo) and plots total FSAE
// points vs FD, annotated in teeth. Collapsed by default — the sweep runs on
// first expand. The explicit `{ ...vehicle, finalDrive }` override happens
// AFTER vehicleForCar identity resolution (don't fight the preset).
function FdOptimizerSection({
  curve, vehicle, baseline,
}: {
  curve: TorqueCurve;
  vehicle: VehicleConfig;
  baseline: ReferenceBaseline;
}) {
  const [open, setOpen] = useState(false);

  const rows = useMemo<FdSweepRow[] | null>(() => {
    if (!open || curve.length === 0) return null;
    return sweepFinalDrive(curve, vehicle, baseline);
  }, [open, curve, vehicle, baseline]);

  const scored = rows?.filter((r) => r.events.totalPoints != null) ?? [];
  const havePoints = scored.length > 0;
  // Rank by total points when scorable, else by endurance lap time.
  const ranked = rows
    ? [...rows].sort((a, b) =>
        havePoints
          ? (b.events.totalPoints ?? -Infinity) - (a.events.totalPoints ?? -Infinity)
          : a.events.endurance.lapTimeS - b.events.endurance.lapTimeS)
    : [];
  const best = ranked[0] ?? null;
  // The row the car is on today (nearest swept ratio to the vehicle's FD).
  const current = rows
    ? rows.reduce((c, r) => (Math.abs(r.fd - vehicle.finalDrive) < Math.abs(c.fd - vehicle.finalDrive) ? r : c))
    : null;

  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">Final-drive optimizer</span>
        <span className="text-[9px] text-[#5A5F66]">
          sprocket sweep · current FD {vehicle.finalDrive.toFixed(2)} · same scoring chain as the events table
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
        >
          {open ? "Hide" : "Sweep sprockets"}
        </button>
      </div>

      {open && rows && (
        <div className="flex flex-col gap-2 p-2">
          {havePoints ? (
            <LinePlot
              title="total FSAE points vs final drive"
              xs={scored.map((r) => r.fd)}
              series={[
                { label: "total pts", y: scored.map((r) => r.events.totalPoints as number), color: "#FFC627", showPoints: true },
                ...(current && current.events.totalPoints != null ? [{
                  label: `current (${vehicle.finalDrive.toFixed(2)})`,
                  xs: [current.fd], y: [current.events.totalPoints], color: "#4FC3F7", showPoints: true,
                } satisfies LineSeries] : []),
              ]}
              xLabel="final drive (rear/front)" yLabel="pts" height={260}
            />
          ) : (
            <p className="px-2 py-3 text-[10px] text-[#5A5F66]">
              No reference baseline → no points to rank. Set one in the events table above;
              the table below ranks by endurance lap time meanwhile.
            </p>
          )}

          <table className="w-full text-left font-mono text-[10px]">
            <caption className="sr-only">Top final-drive options ranked by total FSAE points</caption>
            <thead className="bg-[#0B0B0D] text-[9px] uppercase tracking-wider text-[#5A5F66]">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
                <th>FD</th>
                <th>teeth (rear/front)</th>
                <th className="text-right">accel (s)</th>
                <th className="text-right">AX (s)</th>
                <th className="text-right">EN (s/lap)</th>
                <th className="text-right">eff pts</th>
                <th className="text-right">total pts</th>
                <th className="text-right">Δ vs current</th>
              </tr>
            </thead>
            <tbody>
              {ranked.slice(0, 8).map((r) => {
                const isCurrent = current != null && r.fd === current.fd;
                const isBest = best != null && r.fd === best.fd;
                const dTotal =
                  r.events.totalPoints != null && current?.events.totalPoints != null
                    ? r.events.totalPoints - current.events.totalPoints
                    : null;
                return (
                  <tr
                    key={r.fd}
                    className={
                      "border-t border-[#16171B] " +
                      (isBest ? "text-[#FFC627]" : isCurrent ? "text-[#4FC3F7]" : "text-[#9097A0]")
                    }
                  >
                    <td className="px-2 py-1 tabular-nums">
                      {r.fd.toFixed(3)}
                      {isCurrent && <span className="ml-1 text-[8px] uppercase">current</span>}
                      {isBest && <span className="ml-1 text-[8px] uppercase">best</span>}
                    </td>
                    <td className="px-2 py-1">{r.combos.map(comboLabel).join(" = ")}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.events.accel.timeS.toFixed(3)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.events.autocross.lapTimeS.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.events.endurance.lapTimeS.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.events.efficiency.points?.toFixed(1) ?? "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.events.totalPoints?.toFixed(1) ?? "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {dTotal == null ? "—" : `${dTotal >= 0 ? "+" : ""}${dTotal.toFixed(1)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-2 pb-1 text-[9px] leading-tight text-[#5A5F66]">
            Ratios cover 520-chain sprockets {FD_RANGE_NOTE}. Identical ratios list every tooth pair that
            produces them. Scores use the vehicle, baseline, and fuel exactly as configured above.
          </p>
        </div>
      )}
    </section>
  );
}

const FD_RANGE_NOTE = "(front 12–16T, rear 36–56T, FD 2.4–4.4)";
