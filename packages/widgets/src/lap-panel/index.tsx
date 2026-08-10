import type { Widget } from "../types";
import { LapPanelConfigEditor } from "./config-editor";
import { LapPanelRender, type LapPanelConfig } from "./render";

export const lapPanelWidget: Widget<LapPanelConfig> = {
  type: "lap_panel",
  label: "Lap Panel",
  defaultConfig: { laps: [], perSession: true, hideUntrusted: false },
  ConfigEditor: LapPanelConfigEditor,
  Render: LapPanelRender,
  requiredChannels: () => [],
};

export type { LapPanelConfig, LapEntry } from "./render";
