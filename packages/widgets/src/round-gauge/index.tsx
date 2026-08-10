import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { RoundGaugeConfigEditor } from "./config-editor";
import { RoundGaugeRender, type RoundGaugeConfig } from "./render";

export const roundGaugeWidget: Widget<RoundGaugeConfig> = {
  type: "round_gauge",
  label: "Round Gauge",
  summarize: (c, ch) => (c.channelId ? channelLabel(c.channelId, ch) : null),
  defaultConfig: { channelId: "", units: "", decimals: 0, min: 0, max: 100 },
  ConfigEditor: RoundGaugeConfigEditor,
  Render: RoundGaugeRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { RoundGaugeConfig } from "./render";
