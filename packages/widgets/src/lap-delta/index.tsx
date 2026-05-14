import type { Widget } from "../types";
import { LapDeltaConfigEditor } from "./config-editor";
import { LapDeltaRender, type LapDeltaConfig } from "./render";

export const lapDeltaWidget: Widget<LapDeltaConfig> = {
  type: "lap_delta",
  defaultConfig: {},
  ConfigEditor: LapDeltaConfigEditor,
  Render: LapDeltaRender,
  // Channel requirements are session-level (a speed channel for distance
  // integration), not widget-level — the widget validates and reports
  // missing-data at render time rather than via the required-channels gate.
  requiredChannels: () => [],
};

export type { LapDeltaConfig } from "./render";
export { computeLapDelta, formatDelta } from "./compute";
