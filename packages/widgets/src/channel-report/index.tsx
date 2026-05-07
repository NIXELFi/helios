import type { Widget } from "../types";
import { ChannelReportConfigEditor } from "./config-editor";
import { ChannelReportRender, type ChannelReportConfig } from "./render";

export const channelReportWidget: Widget<ChannelReportConfig> = {
  type: "channel_report",
  defaultConfig: {
    channelIds: ["engine.rpm", "engine.tps"],
    stats: ["avg", "min", "max"],
    hideUntrusted: true,
    perSession: false,
  },
  ConfigEditor: ChannelReportConfigEditor,
  Render: ChannelReportRender,
  requiredChannels: (c) => c.channelIds,
};

export type { ChannelReportConfig, ChannelReportStat } from "./render";
