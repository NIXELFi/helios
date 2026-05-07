import type { WidgetConfigEditorProps } from "../types";
import type { LapPanelConfig } from "./render";

export function LapPanelConfigEditor({ config, onChange }: WidgetConfigEditorProps<LapPanelConfig>) {
  function set<K extends keyof LapPanelConfig>(k: K, v: LapPanelConfig[K]) {
    onChange({ ...config, [k]: v });
  }
  const hasLegacy = config.laps && config.laps.length > 0;
  return (
    <div className="p-2 text-xs text-[#D8DCE2] flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.perSession ?? true}
               onChange={(e) => set("perSession", e.target.checked)}
               className="accent-[#FFC627]" />
        Show all visible sessions
      </label>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.hideUntrusted ?? false}
               onChange={(e) => set("hideUntrusted", e.target.checked)}
               className="accent-[#FFC627]" />
        Hide out-laps / in-laps
      </label>
      <div className="text-[10px] text-[#7B8088] mt-2">
        Lap detection is configured per-session in the Sessions panel.
        Click a lap to make it Main; ⌘-click to make it Ref; shift-click to toggle as an overlay.
      </div>
      {hasLegacy && (
        <button
          className="self-start mt-2 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#7B8088] hover:text-[#EF5350] border border-[#2A2C32] hover:border-[#EF5350]"
          onClick={() => set("laps", [])}
          title="Remove the legacy static lap list — this widget will read from session lap detection"
        >Clear legacy laps ({config.laps.length})</button>
      )}
    </div>
  );
}
