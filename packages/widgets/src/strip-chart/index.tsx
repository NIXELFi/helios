import type { Widget } from "../types";
import { StripChartConfigEditor } from "./config-editor";
import { StripChartRender, type StripChartConfig } from "./render";

export const stripChartWidget: Widget<StripChartConfig> = {
  type: "strip_chart",
  defaultConfig: { channels: [], yMin: 0, yMax: 100 },
  ConfigEditor: StripChartConfigEditor,
  Render: StripChartRender,
  requiredChannels: (c) => c.channels.map((x) => x.id).filter(Boolean),
};

export type { StripChartConfig, StripChartChannel } from "./render";
