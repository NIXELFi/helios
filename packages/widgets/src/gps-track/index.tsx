import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { GpsTrackConfigEditor } from "./config-editor";
import { GpsTrackRender, type GpsTrackConfig } from "./render";

export const gpsTrackWidget: Widget<GpsTrackConfig> = {
  type: "gps_track",
  label: "GPS Track",
  // Only the color-by channel is worth a subtitle; lat/lon are implied.
  summarize: (c, ch) => (c.colorByChannelId ? channelLabel(c.colorByChannelId, ch) : null),
  defaultConfig: { latChannelId: "gps.lat", lonChannelId: "gps.lon" },
  ConfigEditor: GpsTrackConfigEditor,
  Render: GpsTrackRender,
  // imu.lat_g is requested optionally so the turn detector can prefer the
  // chassis-frame cornering signal over GPS curvature when it's present.
  // Tile.tsx filters out unknown channels, so sessions without lat_g still
  // load and the widget falls back to GPS-only detection.
  requiredChannels: (c) => [
    c.latChannelId,
    c.lonChannelId,
    c.colorByChannelId,
    "imu.lat_g",
  ].filter((x): x is string => Boolean(x)),
};

export type { GpsTrackConfig } from "./render";
