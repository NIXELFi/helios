import { useMemo } from "react";
import { formatLapTime } from "@helios/lib";
import type { Lap } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";

export interface TimeReportConfig {
  /** Show one block per visible session vs only the primary. */
  perSession: boolean;
  /** Hide untrusted laps from the table. */
  hideUntrusted: boolean;
  /** Highlight the user-configured best-N-lap rolling window. Set to 0 to
   *  disable the rolling-min calculation. Default 3 (matches MoTeC's default
   *  "rolling minimum" view). */
  rollingWindow: number;
}

interface SummaryStats {
  best: number;
  mean: number;
  median: number;
  stddev: number;
  consistency: number;
  count: number;
  rollingBest: number;
  rollingStartIndex: number;
}

function computeSummary(laps: Lap[], rollingWindow: number): SummaryStats {
  const trusted = laps.filter((l) => l.trusted);
  const times = trusted.map((l) => l.durationS).filter((t) => Number.isFinite(t));
  if (times.length === 0) {
    return { best: NaN, mean: NaN, median: NaN, stddev: NaN, consistency: NaN, count: 0,
             rollingBest: NaN, rollingStartIndex: -1 };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const best = sorted[0]!;
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : sorted[Math.floor(sorted.length / 2)]!;
  const variance = times.length < 2
    ? 0
    : times.reduce((s, t) => s + (t - mean) ** 2, 0) / (times.length - 1);
  const stddev = Math.sqrt(variance);
  // "Consistency" — % of best lap, lower variance = closer to 100. MoTeC uses
  // a similar consistency metric (1 − σ/best). Reported as a percentage.
  const consistency = best > 0 ? Math.max(0, 100 * (1 - stddev / best)) : NaN;
  let rollingBest = NaN, rollingStartIndex = -1;
  if (rollingWindow > 0 && times.length >= rollingWindow) {
    let bestSum = Infinity;
    for (let i = 0; i + rollingWindow <= times.length; i++) {
      let s = 0;
      for (let j = 0; j < rollingWindow; j++) s += times[i + j]!;
      if (s < bestSum) { bestSum = s; rollingStartIndex = i; }
    }
    rollingBest = bestSum / rollingWindow;
  }
  return { best, mean, median, stddev, consistency, count: times.length,
           rollingBest, rollingStartIndex };
}

function fmtSec(s: number): string {
  if (!Number.isFinite(s)) return "—";
  return formatLapTime(s * 1_000_000);
}

function fmtDelta(ds: number): string {
  if (!Number.isFinite(ds) || ds === 0) return "—";
  const sign = ds > 0 ? "+" : "−";
  return `${sign}${Math.abs(ds).toFixed(3)}`;
}

export function TimeReportRender(props: WidgetRenderProps<TimeReportConfig>) {
  const { config, overlays } = props;
  const visible = overlays && overlays.length > 0 ? overlays : [];

  const blocks = useMemo(() => {
    const out: { session: OverlaySession; all: Lap[]; rows: Lap[]; summary: SummaryStats; rollingFullIdx: Set<number> }[] = [];
    for (const session of visible) {
      if (!config.perSession && !session.isPrimary) continue;
      const all = session.laps?.laps ?? [];
      const rows = all.filter((l) => !config.hideUntrusted || l.trusted);
      const summary = computeSummary(all, config.rollingWindow);
      const trustedFullIdx: number[] = [];
      all.forEach((l, idx) => { if (l.trusted) trustedFullIdx.push(idx); });
      const rollingFullIdx = new Set<number>();
      if (config.rollingWindow > 0 && summary.rollingStartIndex >= 0) {
        const start = summary.rollingStartIndex;
        for (let k = 0; k < config.rollingWindow; k++) {
          const fi = trustedFullIdx[start + k];
          if (fi !== undefined) rollingFullIdx.add(fi);
        }
      }
      out.push({ session, all, rows, summary, rollingFullIdx });
    }
    return out;
  }, [visible, config]);

  if (blocks.length === 0 || blocks.every((b) => b.rows.length === 0)) {
    return (
      <div className="w-full h-full bg-[#16171B] flex items-center justify-center text-xs text-[#9097A0]">
        no laps detected — configure detection in the Sessions panel
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto text-[11px]">
      {blocks.map(({ session, all, rows, summary, rollingFullIdx }) => {
        return (
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
                  <th className="text-left px-2 py-1">Lap</th>
                  <th className="text-right px-2 py-1">Time</th>
                  <th className="text-right px-2 py-1">Δ best</th>
                  <th className="text-right px-2 py-1">Δ avg</th>
                  <th className="text-right px-2 py-1">Distance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((lap) => {
                  const isBest = lap.trusted && Number.isFinite(summary.best) && lap.durationS === summary.best;
                  const fullIdx = all.indexOf(lap);
                  const inRolling = rollingFullIdx.has(fullIdx);
                  const dt = Number.isFinite(summary.best) && lap.trusted ? lap.durationS - summary.best : NaN;
                  const dAvg = Number.isFinite(summary.mean) && lap.trusted ? lap.durationS - summary.mean : NaN;
                  return (
                    <tr key={lap.index} className={
                      "border-b border-[#23252B] " +
                      (!lap.trusted ? "text-[#5A5F66]" :
                       isBest ? "text-[#FFC627] bg-[#1F1F23]" :
                       inRolling ? "text-[#D8DCE2] bg-[#16191F]" : "text-[#D8DCE2]")
                    }>
                      <td className="px-2 py-0.5">
                        {lap.index}
                        {!lap.trusted && <span className="ml-1 text-[#9097A0]">·</span>}
                        {isBest && <span className="ml-1 text-[#FFC627]">★</span>}
                      </td>
                      <td className={"text-right px-2 py-0.5 " + (isBest ? "font-bold" : "")}>{fmtSec(lap.durationS)}</td>
                      <td className="text-right px-2 py-0.5">{fmtDelta(dt)}</td>
                      <td className="text-right px-2 py-0.5">{fmtDelta(dAvg)}</td>
                      <td className="text-right px-2 py-0.5 text-[#9097A0]">
                        {Number.isFinite(lap.distanceM) ? `${(lap.distanceM / 1000).toFixed(2)} km` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="text-[#9AA0A6] text-[10px]">
                <tr className="border-t border-[#2A2C32]">
                  <td className="px-2 py-1" colSpan={2}>{summary.count} trusted</td>
                  <td className="text-right px-2 py-1">μ {fmtSec(summary.mean)}</td>
                  <td className="text-right px-2 py-1">σ {Number.isFinite(summary.stddev) ? summary.stddev.toFixed(3) : "—"}</td>
                  <td className="text-right px-2 py-1">cons {Number.isFinite(summary.consistency) ? summary.consistency.toFixed(1) + "%" : "—"}</td>
                </tr>
                {Number.isFinite(summary.rollingBest) && (
                  <tr className="text-[#FFB800]">
                    <td className="px-2 py-0.5" colSpan={2}>roll-{config.rollingWindow}</td>
                    <td className="text-right px-2 py-0.5">{fmtSec(summary.rollingBest)}</td>
                    <td className="text-right px-2 py-0.5" colSpan={2}>avg over best {config.rollingWindow}</td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        );
      })}
    </div>
  );
}

