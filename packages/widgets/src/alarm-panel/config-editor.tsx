import type { WidgetConfigEditorProps } from "../types";
import type { AlarmPanelConfig } from "./render";

export function AlarmPanelConfigEditor({ config, onChange }: WidgetConfigEditorProps<AlarmPanelConfig>) {
  return (
    <div className="p-2 text-xs text-[#7B8088]">
      <div>Static alarms: <span className="text-[#D8DCE2]">{config.alarms.length}</span></div>
      <button className="mt-2 text-[#FFC627]" onClick={() => onChange({ alarms: [] })}>clear alarms</button>
      <p className="mt-2">Live alarm evaluation arrives in Plan 5.</p>
    </div>
  );
}
