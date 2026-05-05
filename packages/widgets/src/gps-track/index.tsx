import type { Widget } from "../types";
import { GpsTrackConfigEditor } from "./config-editor";
import { GpsTrackRender, type GpsTrackConfig } from "./render";

export const gpsTrackWidget: Widget<GpsTrackConfig> = {
  type: "gps_track",
  defaultConfig: { latChannelId: "gps.lat", lonChannelId: "gps.lon" },
  ConfigEditor: GpsTrackConfigEditor,
  Render: GpsTrackRender,
  requiredChannels: (c) => [c.latChannelId, c.lonChannelId, c.colorByChannelId].filter((x): x is string => Boolean(x)),
};

export type { GpsTrackConfig } from "./render";
