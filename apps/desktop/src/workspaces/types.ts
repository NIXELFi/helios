import type {
  StripChartConfig, NumericReadoutConfig, RoundGaugeConfig, BarGaugeConfig,
  EngineBarConfig, GpsTrackConfig, LapPanelConfig, AlarmPanelConfig,
  TireGridConfig, HistogramConfig, XyPlotConfig, SteeringWheelConfig,
  ChannelReportConfig, TimeReportConfig, ZoneStatsConfig, FftConfig,
  LapDeltaConfig, SectorTableConfig,
} from "@helios/widgets";

export type WidgetType =
  | "strip_chart" | "numeric_readout" | "round_gauge" | "bar_gauge"
  | "engine_bar" | "gps_track" | "lap_panel" | "alarm_panel"
  | "tire_grid" | "histogram" | "xy_plot" | "steering_wheel"
  | "channel_report" | "time_report" | "zone_stats" | "fft"
  | "lap_delta" | "sector_table";

export interface TileSpec {
  id: string;
  widgetType: WidgetType;
  config:
    | StripChartConfig | NumericReadoutConfig | RoundGaugeConfig | BarGaugeConfig
    | EngineBarConfig | GpsTrackConfig | LapPanelConfig | AlarmPanelConfig
    | TireGridConfig | HistogramConfig | XyPlotConfig | SteeringWheelConfig
    | ChannelReportConfig | TimeReportConfig | ZoneStatsConfig | FftConfig
    | LapDeltaConfig | SectorTableConfig;
  x: number; y: number; w: number; h: number;
}

export interface Workspace {
  id: string;
  label: string;
  color: string;  // hex string from SESSION_PALETTE (lib/session.ts)
  tiles: TileSpec[];
}
