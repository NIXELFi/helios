import type { WidgetConfigEditorProps } from "../types";
import type { LapPanelConfig } from "./render";

export function LapPanelConfigEditor({ config, onChange }: WidgetConfigEditorProps<LapPanelConfig>) {
  return (
    <div className="p-2 text-xs text-[#7B8088]">
      <div>Static laps: <span className="text-[#D8DCE2]">{config.laps.length}</span></div>
      <button
        className="mt-2 text-[#FFC627]"
        onClick={() => onChange({ laps: [] })}
      >clear laps</button>
      <p className="mt-2">Live lap detection arrives in Plan 4. For now laps come from session config.</p>
    </div>
  );
}
