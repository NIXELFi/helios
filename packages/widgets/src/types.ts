import type { FC } from "react";
import type { ChannelMeta, ChannelSlice, TimeRange } from "@helios/store";
import type { CursorEmitter, ViewStateEmitter, LapSet, LapSelection, LapSelectionEmitter, GpsPickerEmitter } from "@helios/lib";

export interface OverlaySession {
  id: string;
  label: string;
  color: string;
  slice: ChannelSlice;
  range: TimeRange;
  isPrimary: boolean;
  /** Lap set for this session, if detection is configured. Widgets that
   *  partition data per-lap (channel report, time report, distance-axis
   *  strip chart, FFT-by-lap) read from here. */
  laps?: LapSet | null;
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
  /** Global, session-scoped view state shared by every chart: datum markers
   *  and an optional zoom range. Time-axis widgets (strip-chart) opt in by
   *  reading from this; single-value widgets ignore it. */
  viewState?: ViewStateEmitter;
  /** Primary session's lap set. Lap-aware widgets (lap panel, channel
   *  report, time report) read from here. Pass-through alias of
   *  overlays[0].laps but exposed at the top level for convenience. */
  laps?: LapSet | null;
  /** Global lap-selection state (Main / Ref / Overlays). Reads + writes
   *  through the shared LapSelectionEmitter. Widgets that drive the lap
   *  selection (lap panel) write to this; widgets that respond to it
   *  (strip chart in distance mode, variance trace) subscribe. */
  lapSelectionEmitter?: LapSelectionEmitter;
  /** Snapshot of the current lap selection. Same data as
   *  `lapSelectionEmitter.get()` but safe to consume in JSX without
   *  hooking the emitter; widgets that need live updates should subscribe
   *  to the emitter directly. */
  lapSelection?: LapSelection;
  /** Coordinator for "click the GPS track to pick a coordinate" flows.
   *  When armed (Lap Config dialog → "Pick from map"), the GPS Track widget
   *  shows a hint banner and treats the next click as a coordinate emit. */
  gpsPickerEmitter?: GpsPickerEmitter;
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
