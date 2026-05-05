import type { WidgetRenderProps } from "../types";
import { formatClock } from "@helios/lib";

export type AlarmSeverity = "info" | "warn" | "critical";
export interface AlarmEntry {
  id: string;
  severity: AlarmSeverity;
  channel: string;
  value: number;
  message: string;
  t_us: number;
}
export interface AlarmPanelConfig {
  /** Static alarms for Plan 2 — Plan 5 wires live evaluation. */
  alarms: AlarmEntry[];
}

const sevColor = (s: AlarmSeverity) =>
  s === "critical" ? "#EF5350" : s === "warn" ? "#FFB800" : "#4FC3F7";

export function AlarmPanelRender(props: WidgetRenderProps<AlarmPanelConfig>) {
  const { config } = props;
  return (
    <div className="w-full h-full bg-[#16171B] overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-[#7B8088] uppercase text-[10px]">
          <tr className="border-b border-[#2A2C32]">
            <th className="text-left px-2 py-1">When</th>
            <th className="text-left px-2 py-1">Channel</th>
            <th className="text-right px-2 py-1">Value</th>
            <th className="text-left px-2 py-1">Message</th>
          </tr>
        </thead>
        <tbody>
          {config.alarms.length === 0 && (
            <tr><td colSpan={4} className="text-center text-[#7B8088] py-4">no alarms</td></tr>
          )}
          {config.alarms.map((a) => (
            <tr key={a.id} className="border-b border-[#23252B]">
              <td className="px-2 py-1 font-mono-num text-[#7B8088]">{formatClock(a.t_us)}</td>
              <td className="px-2 py-1" style={{ color: sevColor(a.severity) }}>● {a.channel}</td>
              <td className="text-right px-2 py-1 font-mono-num">{a.value.toFixed(2)}</td>
              <td className="px-2 py-1 text-[#D8DCE2]">{a.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
