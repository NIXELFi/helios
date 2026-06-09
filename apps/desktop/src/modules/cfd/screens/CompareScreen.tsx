// Compare screen: pin up to four designs (sweeps / optimization bests), see
// their torque curves overlaid and their FSAE event scores side by side, and —
// the point of the tab — attribute the gap between any two: morph A into B
// one factor at a time (engine → mass → gearing → chassis) and show what each
// step costs or buys per event. Deltas telescope (they sum exactly to B − A),
// so the attribution can't lie. Same computeEvents as everywhere else.

import { useMemo, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { LinePlot } from "../components/charts/LinePlot";
import { sourcesFrom, type CurveSource } from "../lib/curveSources";
import { ReportButton } from "../components/ReportButton";
import {
  carKeyForConfig,
  vehicleForCar,
  torqueCurveFromSweep,
  peakTorque,
  computeEvents,
  attributeGap,
  stepDeltas,
  type EventScores,
  type GapStep,
  type TorqueCurve,
  type VehicleConfig,
} from "../lib/performance";

const PIN_COLORS = ["#FFC627", "#4FC3F7", "#A5D6A7", "#F48FB1"];
const MAX_PINS = 4;

interface Pinned {
  source: CurveSource;
  curve: TorqueCurve;
  vehicle: VehicleConfig;
  events: EventScores;
  color: string;
}

export function CompareScreen() {
  const { state, navigateTo } = useCfd();
  const baseline = state.referenceBaseline;
  const sources = useMemo(() => sourcesFrom(state.studies), [state.studies]);

  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [gapA, setGapA] = useState<string | null>(null);
  const [gapB, setGapB] = useState<string | null>(null);

  const pinned: Pinned[] = useMemo(() => {
    const out: Pinned[] = [];
    for (const id of pinnedIds) {
      const source = sources.find((s) => s.id === id);
      if (!source) continue;
      const curve = torqueCurveFromSweep(source.points);
      if (curve.length === 0) continue;
      const vehicle = vehicleForCar(carKeyForConfig(source.configName), state.vehicleConfig);
      out.push({
        source,
        curve,
        vehicle,
        events: computeEvents(curve, vehicle, baseline),
        color: PIN_COLORS[out.length % PIN_COLORS.length]!,
      });
    }
    return out;
  }, [pinnedIds, sources, state.vehicleConfig, baseline]);

  const a = pinned.find((p) => p.source.id === gapA) ?? pinned[0] ?? null;
  const b = pinned.find((p) => p.source.id === gapB && p.source.id !== a?.source.id)
    ?? pinned.find((p) => p.source.id !== a?.source.id) ?? null;

  const gapSteps: GapStep[] | null = useMemo(() => {
    if (!a || !b) return null;
    return attributeGap(
      { label: a.source.label, curve: a.curve, vehicle: a.vehicle },
      { label: b.source.label, curve: b.curve, vehicle: b.vehicle },
      baseline,
    );
  }, [a, b, baseline]);

  const addable = sources.filter((s) => !pinnedIds.includes(s.id));

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Compare</div>
          <p className="text-[10px] text-[#5A5F66]">
            pin designs · overlay curves · attribute the gap (engine vs mass vs gearing vs chassis)
          </p>
        </div>
        <ReportButton
          defaultOnly={pinnedIds.length > 0 ? pinnedIds : undefined}
          label={pinnedIds.length > 0 ? "Report — pinned (PDF)" : "Full report (PDF)"}
          title={pinnedIds.length > 0 ? "Helios CFD — Design Comparison Report" : undefined}
        />
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#9097A0]">
          Pin design
          <select
            aria-label="Pin a design"
            className="max-w-[260px] rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-1 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
            value=""
            disabled={pinnedIds.length >= MAX_PINS}
            onChange={(e) => {
              const v = e.target.value;
              if (v) setPinnedIds((ids) => (ids.includes(v) ? ids : [...ids, v].slice(0, MAX_PINS)));
            }}
          >
            <option value="">{pinnedIds.length >= MAX_PINS ? "(max 4 pinned)" : "(choose…)"}</option>
            {addable.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {pinned.length === 0 ? (
          <div className="m-4 rounded-sm border border-dashed border-[#2A2C32] p-8 text-center text-[11px] text-[#5A5F66]">
            Pin two or more designs (sweeps or optimization bests) to compare them.
            {sources.length === 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300"
                  onClick={() => navigateTo("studies")}
                >
                  Go to studies
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Scoreboard */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <div className="border-b border-[#2A2C32] px-3 py-2 text-[10px] uppercase tracking-wider text-[#9097A0]">
                Scoreboard {pinned.length > 1 && <span className="text-[#5A5F66]">— Δ vs first pin</span>}
              </div>
              <table className="w-full text-left font-mono text-[11px]">
                <thead className="bg-[#0B0B0D] text-[9px] uppercase tracking-wider text-[#5A5F66]">
                  <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:font-normal">
                    <th>design</th>
                    <th className="text-right">peak τ</th>
                    <th className="text-right">accel</th>
                    <th className="text-right">AX</th>
                    <th className="text-right">EN /lap</th>
                    <th className="text-right">eff pts</th>
                    <th className="text-right">total pts</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="[&>tr]:border-t [&>tr]:border-[#16171B] [&>tr>td]:px-2 [&>tr>td]:py-1.5">
                  {pinned.map((p, i) => {
                    const pk = peakTorque(p.curve);
                    const ref = pinned[0]!;
                    const dTotal = i > 0 && p.events.totalPoints != null && ref.events.totalPoints != null
                      ? p.events.totalPoints - ref.events.totalPoints
                      : null;
                    return (
                      <tr key={p.source.id}>
                        <td>
                          <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: p.color }} />
                          <span className="text-[#D8DCE2]">{p.source.label}</span>
                          <span className="ml-1.5 text-[9px] text-[#5A5F66]">{p.vehicle.name} · {p.vehicle.massKg.toFixed(0)} kg · FD {p.vehicle.finalDrive.toFixed(2)}</span>
                        </td>
                        <td className="text-right text-[#9097A0]">{pk ? `${pk.torqueNm.toFixed(1)} Nm` : "—"}</td>
                        <td className="text-right">{p.events.accel.timeS.toFixed(3)} s</td>
                        <td className="text-right">{p.events.autocross.lapTimeS.toFixed(2)} s</td>
                        <td className="text-right">{p.events.endurance.lapTimeS.toFixed(2)} s</td>
                        <td className="text-right">{p.events.efficiency.points?.toFixed(1) ?? "—"}</td>
                        <td className="text-right text-[13px] text-[#FFC627]">
                          {p.events.totalPoints?.toFixed(1) ?? "—"}
                          {dTotal != null && (
                            <span className={"ml-1 text-[10px] " + (dTotal >= 0 ? "text-[#A5D6A7]" : "text-[#FF8A65]")}>
                              {dTotal >= 0 ? "+" : ""}{dTotal.toFixed(1)}
                            </span>
                          )}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            aria-label={`Unpin ${p.source.label}`}
                            onClick={() => setPinnedIds((ids) => ids.filter((id) => id !== p.source.id))}
                            className="rounded-sm border border-[#2A2C32] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#5A5F66] hover:border-[#FF5252] hover:text-[#FF5252]"
                          >
                            unpin
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {/* Torque overlay */}
            <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
              <LinePlot
                title="torque curves"
                series={pinned.map((p) => ({
                  label: p.source.configName,
                  xs: p.curve.map((pt) => pt.rpm),
                  y: p.curve.map((pt) => pt.torqueNm),
                  color: p.color,
                  width: 2,
                  showPoints: false,
                }))}
                xLabel="rpm"
                yLabel="Nm"
                height={280}
              />
            </section>

            {/* Gap attribution */}
            {pinned.length >= 2 && a && b && gapSteps && (
              <GapPanel
                pinned={pinned}
                a={a}
                b={b}
                steps={gapSteps}
                onPick={(aId, bId) => { setGapA(aId); setGapB(bId); }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const GAP_METRICS: { label: string; unit: string; lowerBetter: boolean; get: (e: EventScores) => number | null; fmt: (n: number) => string }[] = [
  { label: "autocross", unit: "s", lowerBetter: true, get: (e) => e.autocross.lapTimeS, fmt: (n) => n.toFixed(2) },
  { label: "endurance", unit: "s/lap", lowerBetter: true, get: (e) => e.endurance.lapTimeS, fmt: (n) => n.toFixed(2) },
  { label: "accel", unit: "s", lowerBetter: true, get: (e) => e.accel.timeS, fmt: (n) => n.toFixed(3) },
  { label: "total", unit: "pts", lowerBetter: false, get: (e) => e.totalPoints, fmt: (n) => n.toFixed(1) },
];

function GapPanel({
  pinned, a, b, steps, onPick,
}: {
  pinned: Pinned[];
  a: Pinned;
  b: Pinned;
  steps: GapStep[];
  onPick: (aId: string, bId: string) => void;
}) {
  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#2A2C32] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-[#FFC627]">Gap attribution</span>
        <select
          aria-label="Attribution baseline (A)"
          className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-0.5 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
          value={a.source.id}
          onChange={(e) => onPick(e.target.value, b.source.id)}
        >
          {pinned.map((p) => <option key={p.source.id} value={p.source.id}>A: {p.source.configName}</option>)}
        </select>
        <span className="text-[10px] text-[#5A5F66]">→</span>
        <select
          aria-label="Attribution target (B)"
          className="rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-2 py-0.5 font-mono text-[10px] text-[#D8DCE2] focus:border-[#FFC627] focus:outline-none"
          value={b.source.id}
          onChange={(e) => onPick(a.source.id, e.target.value)}
        >
          {pinned.filter((p) => p.source.id !== a.source.id).map((p) => (
            <option key={p.source.id} value={p.source.id}>B: {p.source.configName}</option>
          ))}
        </select>
        <span className="text-[9px] text-[#5A5F66]">
          morph A→B one factor at a time; steps sum exactly to B − A
        </span>
      </div>
      <table className="w-full text-left font-mono text-[11px]">
        <thead className="bg-[#0B0B0D] text-[9px] uppercase tracking-wider text-[#5A5F66]">
          <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
            <th>step</th>
            {GAP_METRICS.map((m) => <th key={m.label} className="text-right">{m.label} ({m.unit})</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-[#16171B] [&>tr>td]:px-3 [&>tr>td]:py-1.5">
          {steps.map((s, i) => (
            <tr key={s.key} className={i === 0 ? "text-[#9097A0]" : ""}>
              <td className={i === 0 ? "" : "text-[#D8DCE2]"}>
                {i === 0 ? `A = ${a.source.configName}` : `+ ${s.label}`}
              </td>
              {GAP_METRICS.map((m) => {
                const v = m.get(s.events);
                if (i === 0) {
                  return <td key={m.label} className="text-right">{v != null ? m.fmt(v) : "—"}</td>;
                }
                const d = stepDeltas(steps, m.get)[i];
                const good = d != null && (m.lowerBetter ? d < 0 : d > 0);
                return (
                  <td key={m.label} className="text-right">
                    {d == null ? "—" : (
                      <span className={Math.abs(d) < 5e-3 ? "text-[#5A5F66]" : good ? "text-[#A5D6A7]" : "text-[#FF8A65]"}>
                        {d >= 0 ? "+" : ""}{m.fmt(Math.abs(d) < 5e-3 ? 0 : d)}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="bg-[#16171B]">
            <td className="text-[#D8DCE2]">B = {b.source.configName} (total Δ)</td>
            {GAP_METRICS.map((m) => {
              const va = m.get(steps[0]!.events);
              const vb = m.get(steps[steps.length - 1]!.events);
              const d = va != null && vb != null ? vb - va : null;
              const good = d != null && (m.lowerBetter ? d < 0 : d > 0);
              return (
                <td key={m.label} className={"text-right text-[12px] " + (d == null ? "" : good ? "text-[#A5D6A7]" : "text-[#FF8A65]")}>
                  {d == null ? "—" : `${d >= 0 ? "+" : ""}${m.fmt(d)}`}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <p className="px-3 py-2 text-[9px] leading-tight text-[#5A5F66]">
        Order matters: interactions land on the later step (engine first, then mass, gearing, and the rest of the
        chassis). Green = the step helps B; orange = it hurts. Known cars use their preset identity (mass, final
        drive, gearing) automatically.
      </p>
    </section>
  );
}
