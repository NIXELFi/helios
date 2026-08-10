import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { BarGaugeConfigEditor } from "./config-editor";
import { BarGaugeRender, type BarGaugeConfig } from "./render";

export const barGaugeWidget: Widget<BarGaugeConfig> = {
  type: "bar_gauge",
  label: "Bar Gauge",
  summarize: (c, ch) => (c.channelId ? channelLabel(c.channelId, ch) : null),
  defaultConfig: { channelId: "", units: "", decimals: 0, min: 0, max: 100, orientation: "vertical" },
  ConfigEditor: BarGaugeConfigEditor,
  Render: BarGaugeRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { BarGaugeConfig } from "./render";
