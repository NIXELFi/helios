import type { TileSpec } from "./types";

export const engineFocus: TileSpec[] = [
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
      ],
      yMin: 0, yMax: 15000,
    },
    x: 0, y: 0.10, w: 1, h: 0.30,
  },
  {
    id: "throttle-strip",
    widgetType: "strip_chart",
    config: {
      channels: [
        { id: "engine.tps", color: "#4FC3F7" },
      ],
      yMin: 0, yMax: 100,
    },
    x: 0, y: 0.40, w: 0.6, h: 0.30,
  },
  {
    id: "rpm-gauge",
    widgetType: "round_gauge",
    config: {
      channelId: "engine.rpm", units: "rpm", decimals: 0,
      min: 0, max: 14000, warn: 12000, alarm: 13500,
    },
    x: 0.6, y: 0.40, w: 0.20, h: 0.30,
  },
  {
    id: "throttle-readout",
    widgetType: "numeric_readout",
    config: { channelId: "engine.tps", units: "%", decimals: 1 },
    x: 0.80, y: 0.40, w: 0.20, h: 0.15,
  },
  {
    id: "gear-readout",
    widgetType: "numeric_readout",
    config: { channelId: "engine.gear", units: "", decimals: 0 },
    x: 0.80, y: 0.55, w: 0.20, h: 0.15,
  },
  {
    id: "water-bar",
    widgetType: "bar_gauge",
    config: { channelId: "engine.water_temp", units: "°C", decimals: 1, min: 60, max: 130, warn: 105, alarm: 115, orientation: "vertical" },
    x: 0, y: 0.70, w: 0.10, h: 0.30,
  },
  {
    id: "oil-bar",
    widgetType: "bar_gauge",
    config: { channelId: "engine.oil_temp", units: "°C", decimals: 1, min: 60, max: 150, warn: 120, alarm: 135, orientation: "vertical" },
    x: 0.10, y: 0.70, w: 0.10, h: 0.30,
  },
  {
    id: "rpm-hist",
    widgetType: "histogram",
    config: { channelId: "engine.rpm", bins: 30, color: "#FFB800" },
    x: 0.20, y: 0.70, w: 0.40, h: 0.30,
  },
  {
    id: "rpm-vs-throttle",
    widgetType: "xy_plot",
    config: {
      xChannelId: "engine.rpm", yChannelId: "engine.tps",
      xMin: 0, xMax: 14000, yMin: 0, yMax: 100,
      color: "#FFC627", trail: true,
    },
    x: 0.60, y: 0.70, w: 0.40, h: 0.30,
  },
];
