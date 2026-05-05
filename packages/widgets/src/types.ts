import type { FC } from "react";
import type { ChannelSlice, TimeRange } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";

export interface WidgetRenderProps<Config> {
  config: Config;
  slice: ChannelSlice;
  cursorEmitter: CursorEmitter;
  timeRange: TimeRange;
}

export interface WidgetConfigEditorProps<Config> {
  config: Config;
  onChange: (next: Config) => void;
}

export interface Widget<Config> {
  type: string;
  defaultConfig: Config;
  ConfigEditor: FC<WidgetConfigEditorProps<Config>>;
  Render: FC<WidgetRenderProps<Config>>;
  requiredChannels: (config: Config) => string[];
}
