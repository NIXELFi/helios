import type { WidgetRenderProps } from "../types";
import { formatLapTime } from "@helios/lib";

export interface LapEntry { number: number; time_ms: number; }
export interface LapPanelConfig {
  /** Static laps for Plan 2 — will be replaced by live detection in Plan 4. */
  laps: LapEntry[];
}

export function LapPanelRender(props: WidgetRenderProps<LapPanelConfig>) {
  const { config } = props;
  const laps = config.laps;
  const best = laps.length === 0 ? null : laps.reduce((a, b) => (b.time_ms < a.time_ms ? b : a)).time_ms;
  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto">
      <table className="w-full text-xs font-mono-num">
        <thead className="text-[#7B8088] uppercase text-[10px]">
          <tr className="border-b border-[#2A2C32]">
            <th className="text-left px-2 py-1">Lap</th>
            <th className="text-right px-2 py-1">Time</th>
            <th className="text-right px-2 py-1">Δ best</th>
          </tr>
        </thead>
        <tbody>
          {laps.length === 0 && (
            <tr><td colSpan={3} className="text-center text-[#7B8088] py-4">no laps detected</td></tr>
          )}
          {laps.map((lap) => {
            const isBest = best !== null && lap.time_ms === best;
            const dt = best !== null ? lap.time_ms - best : 0;
            return (
              <tr key={lap.number} className={`border-b border-[#23252B] ${isBest ? "bg-[#0E0E10]" : ""}`}>
                <td className="px-2 py-1">{lap.number}</td>
                <td className={`text-right px-2 py-1 ${isBest ? "text-[#FFC627] font-bold" : "text-[#D8DCE2]"}`}>{formatLapTime(lap.time_ms * 1000)}</td>
                <td className="text-right px-2 py-1 text-[#7B8088]">{dt === 0 ? "—" : `+${(dt / 1000).toFixed(3)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
