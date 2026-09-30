import type { WidgetConfigEditorProps } from "../types";
import type { AlarmPanelConfig } from "./render";

export function AlarmPanelConfigEditor({ config, onChange }: WidgetConfigEditorProps<AlarmPanelConfig>) {
  return (
    <div className="p-2 text-xs text-helios-dim">
      <div>Static alarms: <span className="text-helios-text">{config.alarms.length}</span></div>
      <button className="mt-2 text-asu-gold" onClick={() => onChange({ alarms: [] })}>clear alarms</button>
      <p className="mt-2">Live alarm evaluation arrives in Plan 5.</p>
    </div>
  );
}
