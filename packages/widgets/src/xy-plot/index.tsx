import type { Widget } from "../types";
import { XyPlotConfigEditor } from "./config-editor";
import { XyPlotRender, type XyPlotConfig } from "./render";

export const xyPlotWidget: Widget<XyPlotConfig> = {
  type: "xy_plot",
  defaultConfig: { xChannelId: "", yChannelId: "", color: "#FFB800", trail: false },
  ConfigEditor: XyPlotConfigEditor,
  Render: XyPlotRender,
  requiredChannels: (c) => [c.xChannelId, c.yChannelId].filter(Boolean),
};

export type { XyPlotConfig } from "./render";
