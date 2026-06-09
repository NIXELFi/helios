// Performance screen (P1): turns a study's torque curve into FSAE-relevant
// vehicle numbers — the tractive-effort map, the 75 m acceleration event, and
// the skidpad gear/RPM readout — under an editable VehicleConfig. All scoring is
// frontend math (see cfd/lib/performance); the source torque curve comes from a
// completed sweep or an optimization trial's stored sweepPoints.

import { useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { LinePlot, type LineSeries } from "../components/charts/LinePlot";
import { TrackOverview } from "../components/charts/TrackOverview";
import { basename } from "../lib/cfdPath";
import { buildDesignReportHtml } from "../lib/export/designReport";
import { saveTextFile, fileTimestamp, slugify } from "../lib/export/io";
import {
  carKeyForConfig,
  vehiclePresetForKey,
  torqueCurveFromSweep,
  peakTorque,
  topSpeedMps,
  tractiveMap,
  simAccel,
  skidpad,
  computeEvents,
  AUTOCROSS_2026,
  ENDURANCE_2026,
  REFERENCE_2026,
  trackLength,
  type VehicleConfig,
  type ReferenceBaseline,
  type EventScores,
} from "../lib/performance";
import type { Study, SweepPoint } from "../state/types";

const GEAR_COLORS = ["#FFC627", "#4FC3F7", "#A5D6A7", "#F48FB1", "#CE93D8", "#FF8A65"];

// The lap sim scores against the real 2026 courses (see lib/performance/tracks).
const AX_LEN_M = trackLength(AUTOCROSS_2026);
const EN_LEN_KM = trackLength(ENDURANCE_2026) / 1000;

interface CurveSource {
  id: string;
  label: string;
  configName: string;
  points: SweepPoint[];
}

/** Sweeps (their per-RPM points) and optimization studies (their best trial's
 *  sweepPoints) are the torque-curve sources. */
function sourcesFrom(studies: Record<string, Study>): CurveSource[] {
  const out: CurveSource[] = [];
  for (const s of Object.values(studies)) {
    if (s.kind === "sweep" && s.points.length > 0) {
      out.push({
        id: s.id,
        label: `Sweep · ${basename(s.configPath)} · ${s.points.length} rpm`,
        configName: basename(s.configPath),
        points: s.points,
      });
    } else if (s.kind === "optimization") {
      const best =
        s.bestTrialIdx != null
          ? s.trials.find((t) => t.trialIdx === s.bestTrialIdx)
          : undefined;
      const trial =
        best?.sweepPoints && best.sweepPoints.length > 0
          ? best
          : s.trials.find((t) => t.sweepPoints && t.sweepPoints.length > 0);
      if (trial?.sweepPoints && trial.sweepPoints.length > 0) {
        out.push({
          id: s.id,
          label: `Optimization · ${basename(s.configPath)} · best #${trial.trialIdx}`,
          configName: basename(s.configPath),
          points: trial.sweepPoints,
        });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function PerformanceScreen() {
  const { state, navigateTo, setVehicleConfig, setReferenceBaseline } = useCfd();
  const baseline = state.referenceBaseline;

  const sources = useMemo(() => sourcesFrom(state.studies), [state.studies]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skidpadTime, setSkidpadTime] = useState(4.9);
  const [editorOpen, setEditorOpen] = useState(false);
  const [trackView, setTrackView] = useState<"autocross" | "endurance">("autocross");

  const selected = sources.find((s) => s.id === selectedId) ?? sources[0] ?? null;
  // The vehicle (esp. final drive) auto-matches the loaded config: an SDM25
  // config uses the SDM25 preset (3.5 final drive), SDM26 uses 3.0. Edits to the
  // active car stick; selecting a different car shows that car's preset.
  const carKey = selected ? carKeyForConfig(selected.configName) : "SDM26";
  const vehicle =
    state.vehicleConfig.name === carKey ? state.vehicleConfig : vehiclePresetForKey(carKey);
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
        autocross: AUTOCROSS_2026,
        endurance: ENDURANCE_2026,
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

            {/* Track overview — the loaded course the events are scored on. */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="flex items-center justify-between border-b border-[#2A2C32] px-3 py-2">
                <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">Track overview</span>
                <div className="flex items-center gap-1">
                  {(["autocross", "endurance"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTrackView(t)}
                      className={
                        "rounded-sm border px-2 py-0.5 text-[9px] uppercase tracking-wider " +
                        (trackView === t
                          ? "border-[#FFC627] text-[#FFC627]"
                          : "border-[#2A2C32] text-[#9097A0] hover:border-[#FFC627]/60")
                      }
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-3">
                <TrackOverview track={trackView === "autocross" ? AUTOCROSS_2026 : ENDURANCE_2026} />
              </div>
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
