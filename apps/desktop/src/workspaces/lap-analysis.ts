import type { TileSpec } from "./types";

/** Lap-analysis workspace — pairs the new lap-aware widgets so the user sees
 *  the parity-with-i2 features at a glance: lap-time table, channel report,
 *  GPS map, distance-axis strip chart, FFT, and the zone-stats panel. */
export const lapAnalysis: TileSpec[] = [
  {
    id: "time-report",
    widgetType: "time_report",
    config: { perSession: true, hideUntrusted: true, rollingWindow: 3 },
    x: 0, y: 0, w: 0.22, h: 0.45,
  },
  {
    id: "sector-table",
    widgetType: "sector_table",
    config: { sectorCount: 3, maxRows: 6, hideUntrusted: true },
    x: 0.22, y: 0, w: 0.20, h: 0.45,
  },
  {
    id: "lap-panel",
    widgetType: "lap_panel",
    config: { laps: [], perSession: true, hideUntrusted: false },
    x: 0.42, y: 0, w: 0.13, h: 0.45,
  },
  {
    id: "gps-track",
    widgetType: "gps_track",
    config: {
      latChannelId: "gps.lat", lonChannelId: "gps.lon",
      colorByChannelId: "gps.speed", colorMin: 0, colorMax: 50,
      basemap: "none", labels: "turns", labelSensitivity: "medium",
    },
    x: 0.55, y: 0, w: 0.45, h: 0.45,
  },
  {
    id: "distance-strip",
    widgetType: "strip_chart",
    config: {
      channels: [
        { id: "engine.rpm", color: "#FFB800" },
        { id: "engine.tps", color: "#4FC3F7" },
      ],
      yMin: 0, yMax: 15000,
      xMode: "distance",
    },
    x: 0, y: 0.45, w: 1, h: 0.18,
  },
  {
    id: "lap-delta",
    widgetType: "lap_delta",
    config: {},
    x: 0, y: 0.63, w: 1, h: 0.12,
  },
  {
    id: "channel-report",
    widgetType: "channel_report",
    config: {
      channelIds: ["engine.rpm", "engine.tps", "imu.lat_g"],
      stats: ["avg", "min", "max", "abs_max"],
      hideUntrusted: true, perSession: false,
    },
    x: 0, y: 0.75, w: 0.4, h: 0.25,
  },
  {
    id: "zone-stats",
    widgetType: "zone_stats",
    config: { channelIds: ["engine.rpm", "engine.tps", "engine.water_temp"] },
    x: 0.4, y: 0.75, w: 0.3, h: 0.25,
  },
  {
    id: "fft",
    widgetType: "fft",
    config: {
      channelId: "engine.rpm",
      useZoomRange: false, windowed: true,
      scale: "linear", freqScale: "linear", fmaxHz: 0,
    },
    x: 0.70, y: 0.75, w: 0.30, h: 0.25,
  },
];
