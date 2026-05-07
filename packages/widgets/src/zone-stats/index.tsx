import type { Widget } from "../types";
import { ZoneStatsConfigEditor } from "./config-editor";
import { ZoneStatsRender, type ZoneStatsConfig } from "./render";

export const zoneStatsWidget: Widget<ZoneStatsConfig> = {
  type: "zone_stats",
  defaultConfig: { channelIds: ["engine.rpm", "engine.tps"] },
  ConfigEditor: ZoneStatsConfigEditor,
  Render: ZoneStatsRender,
  requiredChannels: (c) => c.channelIds,
};

export type { ZoneStatsConfig } from "./render";
