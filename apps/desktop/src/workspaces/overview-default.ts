import type { TileSpec } from "./types";

export const overviewDefault: TileSpec[] = [
  {
    id: "engine-bar",
    widgetType: "engine_bar",
    config: {
      rpmChannelId: "engine.rpm", gearChannelId: "engine.gear",
      redline: 14000, shiftLightStart: 12000, segments: 30,
    },
    x: 0, y: 0, w: 1, h: 0.10,
  },
  {
    id: "rpm-strip",
    widgetType: "strip_chart",
    config: {
      channels: [
        { id: "engine.rpm", color: "#FFB800" },
        { id: "engine.tps", color: "#4FC3F7" },
      ],
      yMin: 0, yMax: 15000,
    },
    x: 0, y: 0.10, w: 0.7, h: 0.30,
  },
  {
    id: "rpm-gauge",
    widgetType: "round_gauge",
    config: {
      channelId: "engine.rpm", units: "rpm", decimals: 0,
      min: 0, max: 14000, warn: 12000, alarm: 13500,
    },
    x: 0.70, y: 0.10, w: 0.15, h: 0.30,
  },
  {
    id: "rpm-readout",
    widgetType: "numeric_readout",
    config: { channelId: "engine.rpm", units: "rpm", decimals: 0, warn: 12000, alarm: 13500 },
    x: 0.85, y: 0.10, w: 0.15, h: 0.15,
  },
  {
    id: "tps-readout",
    widgetType: "numeric_readout",
    config: { channelId: "engine.tps", units: "%", decimals: 1 },
    x: 0.85, y: 0.25, w: 0.15, h: 0.15,
  },
  {
    id: "gps-track",
    widgetType: "gps_track",
    config: { latChannelId: "gps.lat", lonChannelId: "gps.lon", colorByChannelId: "gps.speed", colorMin: 0, colorMax: 50 },
    x: 0, y: 0.40, w: 0.40, h: 0.30,
  },
  {
    id: "water-bar",
    widgetType: "bar_gauge",
    config: { channelId: "engine.water_temp", units: "°C", decimals: 1, min: 60, max: 130, warn: 105, alarm: 115, orientation: "vertical" },
    x: 0.40, y: 0.40, w: 0.10, h: 0.30,
  },
  {
    id: "oil-bar",
    widgetType: "bar_gauge",
    config: { channelId: "engine.oil_temp", units: "°C", decimals: 1, min: 60, max: 150, warn: 120, alarm: 135, orientation: "vertical" },
    x: 0.50, y: 0.40, w: 0.10, h: 0.30,
  },
  {
    id: "lap-panel",
    widgetType: "lap_panel",
    config: { laps: [
      { number: 1, time_ms: 75432 },
      { number: 2, time_ms: 74100 },
      { number: 3, time_ms: 73850 },
      { number: 4, time_ms: 74220 },
    ] },
    x: 0.60, y: 0.40, w: 0.20, h: 0.30,
  },
  {
    id: "alarm-panel",
    widgetType: "alarm_panel",
    config: { alarms: [
      { id: "demo-1", severity: "warn", channel: "engine.water_temp", value: 107, message: "above warn threshold", t_us: 12_000_000 },
      { id: "demo-2", severity: "info", channel: "engine.gear", value: 6, message: "max gear engaged", t_us: 38_000_000 },
    ] },
    x: 0.80, y: 0.40, w: 0.20, h: 0.30,
  },
  {
    id: "rpm-hist",
    widgetType: "histogram",
    config: { channelId: "engine.rpm", bins: 30, color: "#FFB800" },
    x: 0, y: 0.70, w: 0.30, h: 0.30,
  },
  {
    id: "gg-plot",
    widgetType: "xy_plot",
    config: {
      xChannelId: "imu.lat_g", yChannelId: "engine.tps",
      xMin: -2, xMax: 2, yMin: 0, yMax: 100,
      color: "#FFC627", trail: true,
    },
    x: 0.30, y: 0.70, w: 0.30, h: 0.30,
  },
  {
    id: "tire-grid",
    widgetType: "tire_grid",
    config: {
      tempChannels:     { lf: "tires.lf_temp", rf: "tires.rf_temp", lr: "tires.lr_temp", rr: "tires.rr_temp" },
      pressureChannels: { lf: "tires.lf_psi",  rf: "tires.rf_psi",  lr: "tires.lr_psi",  rr: "tires.rr_psi"  },
      tempMin: 60, tempMax: 110, tempCool: 75, tempHot: 100,
    },
    x: 0.60, y: 0.70, w: 0.40, h: 0.30,
  },
];
