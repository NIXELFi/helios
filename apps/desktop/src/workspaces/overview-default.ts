import type { StripChartConfig, NumericReadoutConfig } from "@helios/widgets";

export interface TileSpec {
  id: string;
  widgetType: "strip_chart" | "numeric_readout";
  config: StripChartConfig | NumericReadoutConfig;
  x: number; y: number; w: number; h: number;
}

export const overviewDefault: TileSpec[] = [
  {
    id: "rpm-strip",
    widgetType: "strip_chart",
    config: {
      channels: [{ id: "engine.rpm", color: "#FFB800" }],
      yMin: 0, yMax: 15000,
    } satisfies StripChartConfig,
    x: 0, y: 0, w: 1, h: 0.65,
  },
  {
    id: "rpm-readout",
    widgetType: "numeric_readout",
    config: {
      channelId: "engine.rpm", units: "rpm", decimals: 0,
      warn: 13500, alarm: 14500,
    } satisfies NumericReadoutConfig,
    x: 0, y: 0.65, w: 1, h: 0.35,
  },
];
