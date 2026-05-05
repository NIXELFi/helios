import type {
  StripChartConfig, NumericReadoutConfig, RoundGaugeConfig, BarGaugeConfig,
  EngineBarConfig, GpsTrackConfig, LapPanelConfig, AlarmPanelConfig,
  TireGridConfig, HistogramConfig, XyPlotConfig,
} from "@helios/widgets";

export type WidgetType =
  | "strip_chart" | "numeric_readout" | "round_gauge" | "bar_gauge"
  | "engine_bar" | "gps_track" | "lap_panel" | "alarm_panel"
  | "tire_grid" | "histogram" | "xy_plot";

export interface TileSpec {
  id: string;
  widgetType: WidgetType;
  config:
    | StripChartConfig | NumericReadoutConfig | RoundGaugeConfig | BarGaugeConfig
    | EngineBarConfig | GpsTrackConfig | LapPanelConfig | AlarmPanelConfig
    | TireGridConfig | HistogramConfig | XyPlotConfig;
  x: number; y: number; w: number; h: number;
}

export interface Workspace {
  id: string;
  label: string;
  tiles: TileSpec[];
}
