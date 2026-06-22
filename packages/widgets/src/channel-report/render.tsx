import { useMemo } from "react";
import { formatLapTime } from "@helios/lib";
import type { Lap } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";

export type ChannelReportStat =
  | "avg" | "min" | "max" | "abs_max" | "start" | "end" | "change" | "stddev";

export interface ChannelReportConfig {
  /** Channels to summarize, one column per entry. */
  channelIds: string[];
  /** Statistics to show, one column per stat. */
  stats: ChannelReportStat[];
  /** Hide untrusted laps (out / in laps) from the table. */
  hideUntrusted: boolean;
  /** When true and multiple sessions are visible, render one stacked block
   *  per session. When false, only the primary session's laps appear. */
  perSession: boolean;
}

const STAT_LABELS: Record<ChannelReportStat, string> = {
  avg: "avg", min: "min", max: "max", abs_max: "|max|",
  start: "start", end: "end", change: "Δ", stddev: "σ",
};

interface Aggregate {
  n: number;
  min: number;
  max: number;
  absMax: number;
  sum: number;
  sumSq: number;
  start: number;
  end: number;
}

const EMPTY: Aggregate = {
  n: 0, min: Infinity, max: -Infinity, absMax: 0, sum: 0, sumSq: 0,
  start: NaN, end: NaN,
};

function computeStat(stat: ChannelReportStat, a: Aggregate): number {
  if (a.n === 0) return NaN;
  switch (stat) {
    case "avg":     return a.sum / a.n;
    case "min":     return a.min;
    case "max":     return a.max;
    case "abs_max": return a.absMax;
    case "start":   return a.start;
    case "end":     return a.end;
    case "change":  return a.end - a.start;
    case "stddev": {
      if (a.n < 2) return 0;
      const m = a.sum / a.n;
      const v = (a.sumSq - a.n * m * m) / (a.n - 1);
      return v < 0 ? 0 : Math.sqrt(v);
    }
  }
}

function fmt(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

function aggregateForLap(
  values: Float64Array, time: BigInt64Array, lap: Lap,
): Aggregate {
  const out: Aggregate = { ...EMPTY };
  const n = Math.min(values.length, time.length);
  for (let i = 0; i < n; i++) {
    const t = Number(time[i]!);
    if (t < lap.startUs) continue;
    if (t > lap.endUs) break;
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (out.n === 0) out.start = v;
    out.end = v;
    if (v < out.min) out.min = v;
    if (v > out.max) out.max = v;
    const av = Math.abs(v);
    if (av > out.absMax) out.absMax = av;
    out.sum += v;
    out.sumSq += v * v;
    out.n++;
  }
  return out;
}

export function ChannelReportRender(props: WidgetRenderProps<ChannelReportConfig>) {
  const { config, overlays } = props;
  const visible = overlays && overlays.length > 0 ? overlays : [];

  // Stable key: only session ids + config drive the report content. The
  // `visible` array identity changes every parent render but session ids are
  // what actually matter; using a string key prevents defeating the memo.
  const visibleIdsKey = JSON.stringify(visible.map((v) => v.id));

  const blocks = useMemo(() => {
    const list: { session: OverlaySession; rows: Array<{ lap: Lap; cells: number[][] }> }[] = [];
    for (const session of visible) {
      if (!config.perSession && !session.isPrimary) continue;
      const laps = session.laps?.laps ?? [];
      const rows = laps
        .filter((l) => !config.hideUntrusted || l.trusted)
        .map((lap) => {
          const cells = config.channelIds.map((chId) => {
            const arr = session.slice.data.get(chId);
            if (!arr) return config.stats.map(() => NaN);
            const agg = aggregateForLap(arr, session.slice.time, lap);
            return config.stats.map((s) => computeStat(s, agg));
          });
          return { lap, cells };
        });
      list.push({ session, rows });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, config]);

  if (blocks.length === 0 || blocks.every((b) => b.rows.length === 0)) {
    return (
      <div className="w-full h-full bg-[#16171B] flex items-center justify-center text-xs text-[#9097A0]">
        no laps detected — configure detection in the Sessions panel
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto text-[11px]">
      {blocks.map(({ session, rows }) => (
        <div key={session.id} className="mb-2">
          {visible.length > 1 && (
            <div className="px-2 py-1 flex items-center gap-2 bg-[#0E0E10] border-b border-[#2A2C32]">
              <span className="w-2 h-2 rounded-sm" style={{ background: session.color }} aria-hidden />
              <span className="text-[10px] uppercase tracking-wider text-[#9097A0]">{session.label}</span>
            </div>
          )}
          <table className="w-full font-mono-num">
            <thead className="text-[#9097A0] text-[9px] uppercase tracking-wider">
              <tr className="border-b border-[#2A2C32]">
                <th className="text-left px-2 py-1 sticky left-0 bg-[#16171B]">Lap</th>
                <th className="text-right px-2 py-1">Time</th>
                {config.channelIds.map((id) => (
                  <th key={id} colSpan={config.stats.length}
                      className="text-center px-2 py-1 border-l border-[#2A2C32]">
                    {id}
                  </th>
                ))}
              </tr>
              <tr className="border-b border-[#2A2C32]">
                <th />
                <th />
                {config.channelIds.flatMap((id) =>
                  config.stats.map((s, i) => (
                    <th key={id + s} className={
                      "text-right px-2 py-0.5 text-[#5A5F66] " + (i === 0 ? "border-l border-[#2A2C32]" : "")
                    }>{STAT_LABELS[s]}</th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ lap, cells }) => (
                <tr key={lap.index} className={
                  "border-b border-[#23252B] " + (!lap.trusted ? "text-[#5A5F66]" : "text-[#D8DCE2]")
                }>
                  <td className="px-2 py-0.5 sticky left-0 bg-[#16171B]">
                    {lap.index}{!lap.trusted && <span className="ml-1 text-[#9097A0]">·</span>}
                  </td>
                  <td className="text-right px-2 py-0.5">{formatLapTime(lap.durationS * 1_000_000)}</td>
                  {cells.flatMap((cellStats, ci) =>
                    cellStats.map((v, si) => (
                      <td key={ci + ":" + si} className={
                        "text-right px-2 py-0.5 " + (si === 0 ? "border-l border-[#2A2C32]" : "")
                      }>{fmt(v)}</td>
                    )),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
