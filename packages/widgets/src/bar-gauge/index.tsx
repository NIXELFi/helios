import type { Widget } from "../types";
import { BarGaugeConfigEditor } from "./config-editor";
import { BarGaugeRender, type BarGaugeConfig } from "./render";

export const barGaugeWidget: Widget<BarGaugeConfig> = {
  type: "bar_gauge",
  defaultConfig: { channelId: "", units: "", decimals: 0, min: 0, max: 100, orientation: "vertical" },
  ConfigEditor: BarGaugeConfigEditor,
  Render: BarGaugeRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { BarGaugeConfig } from "./render";
