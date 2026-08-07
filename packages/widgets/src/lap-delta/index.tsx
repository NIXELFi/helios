import type { Widget } from "../types";
import { LapDeltaConfigEditor } from "./config-editor";
import { LapDeltaRender, type LapDeltaConfig } from "./render";

export const lapDeltaWidget: Widget<LapDeltaConfig> = {
  type: "lap_delta",
  defaultConfig: {},
  ConfigEditor: LapDeltaConfigEditor,
  Render: LapDeltaRender,
  // Channel requirements are session-level (a speed channel for distance
  // integration), not widget-level — requiresSpeed tells the host to include
  // each session's speed channel(s) in the slice; the widget still validates
  // and reports missing-data at render time.
  requiredChannels: () => [],
  requiresSpeed: () => true,
};

export type { LapDeltaConfig } from "./render";
export { computeLapDelta, formatDelta } from "./compute";
