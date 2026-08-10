import { useMemo } from "react";
import { perSampleLapDistance } from "@helios/lib";
import type { WidgetRenderProps, OverlaySession } from "../types";
import { WidgetEmpty } from "../lib/widget-empty";
import { findSpeed } from "../lib/speed";
import { buildSectorTable, formatLapTime, type LapInput } from "./compute";

export interface SectorTableConfig {
  /** Number of equal-distance sectors to split each lap into. Default 3. */
  sectorCount: number;
  /** Cap on laps shown; oldest dropped. Default 8 — enough to compare a
   *  practice session without scrolling but small enough to stay readable
   *  in a small tile. */
  maxRows: number;
  /** When true, only laps flagged trusted are included. Default true. */
  hideUntrusted: boolean;
}

const PURPLE = "#BA68C8";
const BEST_LAP = "#FFC627";

export function SectorTableRender(props: WidgetRenderProps<SectorTableConfig>) {
  const { config, slice, timeRange, overlays } = props;
  const visible: OverlaySession[] = overlays && overlays.length > 0
    ? overlays
    : [{ id: "primary", label: "primary", color: "#FFC627", slice, range: timeRange, isPrimary: true }];

  const primary = visible.find((o) => o.isPrimary) ?? visible[0]!;
  const visibleIdsKey = JSON.stringify(visible.map((v) => v.id));

  const table = useMemo(() => {
    if (!primary.laps || primary.laps.laps.length === 0) return null;
    const speed = findSpeed(primary);
    if (!speed) return null;
    const dist = perSampleLapDistance(speed.values, speed.unit, primary.slice.time, primary.laps);
    const laps = primary.laps.laps;
    const inputs: LapInput[] = [];
    for (let i = 0; i < laps.length; i++) {
      const lap = laps[i]!;
      if (config.hideUntrusted && !lap.trusted) continue;
      inputs.push({
        timeUs: primary.slice.time,
        dist,
        lapStartUs: lap.startUs,
        lapEndUs: lap.endUs,
        label: `${lap.index}`,
        durationS: lap.durationS,
      });
    }
    // Keep the most recent `maxRows` laps. Tail of the list = most recent.
    const trimmed = inputs.slice(-Math.max(1, config.maxRows));
    return buildSectorTable(trimmed, Math.max(1, config.sectorCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, slice, config.sectorCount, config.maxRows, config.hideUntrusted]);

  if (!table) {
    return (
      <WidgetEmpty
        title="No sector data"
        hint="Sector splits need lap detection and a speed channel on the primary session"
      />
    );
  }

  const bestTotalRowIdx = table.rows.reduce((bestI, r, i) => {
    if (!Number.isFinite(r.totalS)) return bestI;
    if (bestI < 0) return i;
    return r.totalS < table.rows[bestI]!.totalS ? i : bestI;
  }, -1);

  return (
    <div className="w-full h-full bg-helios-panel overflow-auto">
      <table className="w-full text-[11px] font-mono-num tabular-nums">
        <thead>
          <tr className="text-helios-dim text-[10px] uppercase tracking-wider border-b border-helios-line">
            <th className="text-left px-2 py-1 w-12">lap</th>
            {table.names.map((n) => (
              <th key={n} className="text-right px-2 py-1">{n}</th>
            ))}
            <th className="text-right px-2 py-1">total</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="border-b border-helios-line/40">
              <td className="text-left px-2 py-0.5 text-helios-dim">{row.label}</td>
              {row.sectorS.map((v, k) => {
                const isPurple = Number.isFinite(v) && Number.isFinite(table.bestS[k]!) && Math.abs(v - table.bestS[k]!) < 1e-6;
                return (
                  <td
                    key={k}
                    className="text-right px-2 py-0.5"
                    style={{ color: isPurple ? PURPLE : "#D8DCE2" }}
                  >
                    {formatLapTime(v)}
                  </td>
                );
              })}
              <td
                className="text-right px-2 py-0.5"
                style={{ color: i === bestTotalRowIdx ? BEST_LAP : "#D8DCE2" }}
              >
                {formatLapTime(row.totalS)}
              </td>
            </tr>
          ))}
          {/* Theoretical optimal — sum of every sector's purple. */}
          <tr className="border-t border-helios-line">
            <td className="text-left px-2 py-1 text-[10px] uppercase tracking-wider text-helios-dim">opt</td>
            {table.bestS.map((v, k) => (
              <td key={k} className="text-right px-2 py-1" style={{ color: PURPLE }}>
                {formatLapTime(v)}
              </td>
            ))}
            <td className="text-right px-2 py-1" style={{ color: PURPLE }}>
              {formatLapTime(table.optimalTotalS)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
