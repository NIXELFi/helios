import type { WidgetConfigEditorProps } from "../types";
import type { TimeReportConfig } from "./render";

export function TimeReportConfigEditor({ config, onChange }: WidgetConfigEditorProps<TimeReportConfig>) {
  function set<K extends keyof TimeReportConfig>(k: K, v: TimeReportConfig[K]) {
    onChange({ ...config, [k]: v });
  }
  return (
    <div className="p-2 text-xs text-helios-text flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.hideUntrusted}
               onChange={(e) => set("hideUntrusted", e.target.checked)}
               className="accent-asu-gold" />
        Hide out-laps / in-laps
      </label>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.perSession}
               onChange={(e) => set("perSession", e.target.checked)}
               className="accent-asu-gold" />
        Show all visible sessions
      </label>
      <label className="flex items-center gap-2 text-[11px]">
        <span className="text-helios-dim w-24">rolling window</span>
        <input type="number" min={0} max={20} value={config.rollingWindow}
               onChange={(e) => set("rollingWindow", Math.max(0, Math.min(20, Number(e.target.value))))}
               className="w-16 bg-helios-base border border-helios-line px-1 py-0.5" />
        <span className="text-[10px] text-helios-dim">laps (0 = off)</span>
      </label>
    </div>
  );
}
