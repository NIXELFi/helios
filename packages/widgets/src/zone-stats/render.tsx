import { useEffect, useMemo, useState } from "react";
import type { WidgetRenderProps } from "../types";

export interface ZoneStatsConfig {
  channelIds: string[];
}

interface ZoneAgg {
  n: number;
  min: number; max: number;
  start: number; end: number;
  sum: number; sumSq: number;
  durationS: number;
}

function aggregateZone(
  values: Float64Array, time: BigInt64Array,
  startUs: number, endUs: number,
): ZoneAgg {
  const out: ZoneAgg = {
    n: 0, min: Infinity, max: -Infinity, start: NaN, end: NaN,
    sum: 0, sumSq: 0, durationS: Math.max(0, (endUs - startUs) / 1_000_000),
  };
  const n = Math.min(values.length, time.length);
  for (let i = 0; i < n; i++) {
    const t = Number(time[i]!);
    if (t < startUs) continue;
    if (t > endUs) break;
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (out.n === 0) out.start = v;
    out.end = v;
    if (v < out.min) out.min = v;
    if (v > out.max) out.max = v;
    out.sum += v;
    out.sumSq += v * v;
    out.n++;
  }
  return out;
}

function fmt(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(dp);
}

function fmtDur(s: number): string {
  if (!Number.isFinite(s) || s === 0) return "—";
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

export function ZoneStatsRender(props: WidgetRenderProps<ZoneStatsConfig>) {
  const { config, slice, cursorEmitter, viewState } = props;
  const [datums, setDatums] = useState<number[]>(viewState?.get().datums ?? []);
  const [cursorUs, setCursorUs] = useState<number>(cursorEmitter.get());

  useEffect(() => {
    if (!viewState) return;
    return viewState.subscribe((s) => setDatums(s.datums));
  }, [viewState]);
  useEffect(() => cursorEmitter.subscribe((t) => setCursorUs(t)), [cursorEmitter]);

  // Determine the active zone:
  //   2+ datums → between the two most recent (last two in sorted array)
  //   1 datum   → between that datum and the live cursor
  //   0 datums  → no zone
  const zone = useMemo(() => {
    if (datums.length >= 2) {
      const a = datums[datums.length - 2]!;
      const b = datums[datums.length - 1]!;
      return { startUs: Math.min(a, b), endUs: Math.max(a, b), kind: "datum-datum" as const };
    }
    if (datums.length === 1) {
      const a = datums[0]!;
      const b = cursorUs;
      if (Math.abs(a - b) < 1) return null;
      return { startUs: Math.min(a, b), endUs: Math.max(a, b), kind: "datum-cursor" as const };
    }
    return null;
  }, [datums, cursorUs]);

  if (!zone) {
    return (
      <div className="w-full h-full bg-[#16171B] flex items-center justify-center text-[11px] text-[#9097A0] text-center px-4">
        Place a datum (shift+click on a strip chart). The zone is the segment between two datums, or between a datum and the cursor.
      </div>
    );
  }

  const rows = config.channelIds.map((id) => {
    const arr = slice.data.get(id);
    const agg = arr
      ? aggregateZone(arr, slice.time, zone.startUs, zone.endUs)
      : { ...{ n: 0, min: NaN, max: NaN, start: NaN, end: NaN, sum: 0, sumSq: 0,
              durationS: (zone.endUs - zone.startUs) / 1_000_000 } };
    const mean = agg.n > 0 ? agg.sum / agg.n : NaN;
    const stddev = agg.n < 2
      ? 0
      : Math.sqrt(Math.max(0, (agg.sumSq - agg.n * mean * mean) / (agg.n - 1)));
    const slope = agg.durationS > 0 && Number.isFinite(agg.start) && Number.isFinite(agg.end)
      ? (agg.end - agg.start) / agg.durationS
      : NaN;
    return { id, agg, mean, stddev, slope };
  });

  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto text-[11px]">
      <div className="px-2 py-1 flex items-center justify-between bg-[#0E0E10] border-b border-[#2A2C32] sticky top-0">
        <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">
          {zone.kind === "datum-datum" ? "Δ datum" : "datum → cursor"}
        </span>
        <span className="font-mono-num text-[10px] text-[#FFC627]">{fmtDur((zone.endUs - zone.startUs) / 1_000_000)}</span>
      </div>
      <table className="w-full font-mono-num">
        <thead className="text-[#9097A0] text-[9px] uppercase tracking-wider">
          <tr className="border-b border-[#2A2C32]">
            <th className="text-left px-2 py-0.5">Channel</th>
            <th className="text-right px-2 py-0.5">start</th>
            <th className="text-right px-2 py-0.5">end</th>
            <th className="text-right px-2 py-0.5">Δ</th>
            <th className="text-right px-2 py-0.5">avg</th>
            <th className="text-right px-2 py-0.5">σ</th>
            <th className="text-right px-2 py-0.5">min</th>
            <th className="text-right px-2 py-0.5">max</th>
            <th className="text-right px-2 py-0.5">slope/s</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, agg, mean, stddev, slope }) => (
            <tr key={id} className="border-b border-[#23252B] text-[#D8DCE2]">
              <td className="px-2 py-0.5">{id}</td>
              <td className="text-right px-2 py-0.5">{fmt(agg.start)}</td>
              <td className="text-right px-2 py-0.5">{fmt(agg.end)}</td>
              <td className="text-right px-2 py-0.5 text-[#FFB800]">{fmt(agg.end - agg.start)}</td>
              <td className="text-right px-2 py-0.5">{fmt(mean)}</td>
              <td className="text-right px-2 py-0.5">{fmt(stddev)}</td>
              <td className="text-right px-2 py-0.5 text-[#9097A0]">{fmt(agg.min === Infinity ? NaN : agg.min)}</td>
              <td className="text-right px-2 py-0.5 text-[#9097A0]">{fmt(agg.max === -Infinity ? NaN : agg.max)}</td>
              <td className="text-right px-2 py-0.5">{fmt(slope, 3)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={9} className="text-center text-[#9097A0] py-2">add channels in the config panel</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
