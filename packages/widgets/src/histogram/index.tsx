import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { HistogramConfigEditor } from "./config-editor";
import { HistogramRender, type HistogramConfig } from "./render";

export const histogramWidget: Widget<HistogramConfig> = {
  type: "histogram",
  label: "Histogram",
  summarize: (c, ch) => (c.channelId ? channelLabel(c.channelId, ch) : null),
  defaultConfig: { channelId: "", bins: 30, color: "#4FC3F7" },
  ConfigEditor: HistogramConfigEditor,
  Render: HistogramRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { HistogramConfig } from "./render";
