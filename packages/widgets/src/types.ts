import type { FC } from "react";
import type { ChannelMeta, ChannelSlice, TimeRange } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";

export interface OverlaySession {
  id: string;
  label: string;
  color: string;
  slice: ChannelSlice;
  range: TimeRange;
  isPrimary: boolean;
}

export interface WidgetRenderProps<Config> {
  config: Config;
  /** Primary session's slice. Single-value widgets (gauges, readouts) read this. */
  slice: ChannelSlice;
  cursorEmitter: CursorEmitter;
  /** Primary session's time range. */
  timeRange: TimeRange;
  /** All visible sessions, primary first. Multi-trace widgets (strip chart, GPS,
   *  xy plot) iterate this; single-value widgets ignore it. Always populated by
   *  callers, length >= 1 when a session is loaded. */
  overlays?: OverlaySession[];
}

export interface WidgetConfigEditorProps<Config> {
  config: Config;
  onChange: (next: Config) => void;
  /** All channels available in the primary session, used to populate channel
   *  pickers. Empty for editors that don't need channel-id fields. */
  availableChannels: ChannelMeta[];
}

export interface Widget<Config> {
  type: string;
  defaultConfig: Config;
  ConfigEditor: FC<WidgetConfigEditorProps<Config>>;
  Render: FC<WidgetRenderProps<Config>>;
  requiredChannels: (config: Config) => string[];
}
