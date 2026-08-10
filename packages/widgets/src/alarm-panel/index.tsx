import type { Widget } from "../types";
import { AlarmPanelConfigEditor } from "./config-editor";
import { AlarmPanelRender, type AlarmPanelConfig } from "./render";

export const alarmPanelWidget: Widget<AlarmPanelConfig> = {
  type: "alarm_panel",
  label: "Alarm Panel",
  defaultConfig: { alarms: [] },
  ConfigEditor: AlarmPanelConfigEditor,
  Render: AlarmPanelRender,
  requiredChannels: () => [],
};

export type { AlarmPanelConfig, AlarmEntry, AlarmSeverity } from "./render";
