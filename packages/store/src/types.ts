export type DataType = "f32" | "f64" | "u16" | "bool" | "enum";

export interface ChannelMeta {
  id: string;
  display_name: string;
  units: string;
  group: string;
  color: string;
  decimals: number;
  data_type: DataType;
  source: string;
  sample_rate_hz: number;
  min?: number;
  max?: number;
  warn?: number;
  alarm?: number;
  /** Original CSV header text that resolved to this channel. Defined for
   *  ingested channels (every column the CSV loader produces) and undefined
   *  for math/derived channels added at runtime. Used by the per-session
   *  channel-override system: the UI lists every source_header as a possible
   *  override target for any canonical id. */
  source_header?: string;
}

export interface TimeRange {
  startUs: number;
  endUs: number;
}

export interface ChannelSlice {
  /** time index, microseconds, length N */
  time: BigInt64Array;
  /** parallel arrays per requested channel id */
  data: Map<string, Float64Array>;
  /** the time range that was requested (clamped to actual data extent) */
  range: TimeRange;
}
