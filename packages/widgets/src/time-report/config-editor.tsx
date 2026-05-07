import type { WidgetConfigEditorProps } from "../types";
import type { TimeReportConfig } from "./render";

export function TimeReportConfigEditor({ config, onChange }: WidgetConfigEditorProps<TimeReportConfig>) {
  function set<K extends keyof TimeReportConfig>(k: K, v: TimeReportConfig[K]) {
    onChange({ ...config, [k]: v });
  }
  return (
    <div className="p-2 text-xs text-[#D8DCE2] flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.hideUntrusted}
               onChange={(e) => set("hideUntrusted", e.target.checked)}
               className="accent-[#FFC627]" />
        Hide out-laps / in-laps
      </label>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.perSession}
               onChange={(e) => set("perSession", e.target.checked)}
               className="accent-[#FFC627]" />
        Show all visible sessions
      </label>
      <label className="flex items-center gap-2 text-[11px]">
        <span className="text-[#7B8088] w-24">rolling window</span>
        <input type="number" min={0} max={20} value={config.rollingWindow}
               onChange={(e) => set("rollingWindow", Math.max(0, Math.min(20, Number(e.target.value))))}
               className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1 py-0.5" />
        <span className="text-[10px] text-[#7B8088]">laps (0 = off)</span>
      </label>
    </div>
  );
}
