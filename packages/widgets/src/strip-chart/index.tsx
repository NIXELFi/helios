import type { Widget } from "../types";
import { channelListLabel } from "../lib/display-meta";
import { StripChartConfigEditor } from "./config-editor";
import { StripChartRender, type StripChartConfig } from "./render";

export const stripChartWidget: Widget<StripChartConfig> = {
  type: "strip_chart",
  label: "Strip Chart",
  summarize: (c, ch) => channelListLabel(c.channels.map((x) => x.id), ch),
  defaultConfig: { channels: [], yMin: 0, yMax: 100 },
  ConfigEditor: StripChartConfigEditor,
  Render: StripChartRender,
  requiredChannels: (c) => c.channels.map((x) => x.id).filter(Boolean),
  // Distance mode integrates speed into per-lap distance. That speed trace
  // is a session-level dependency, not a plotted channel, so the host must
  // include it in each slice even when the user didn't plot it.
  requiresSpeed: (c) => c.xMode === "distance",
};

export type { StripChartConfig, StripChartChannel } from "./render";
