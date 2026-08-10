import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { NumericReadoutConfigEditor } from "./config-editor";
import { NumericReadoutRender, type NumericReadoutConfig } from "./render";

export const numericReadoutWidget: Widget<NumericReadoutConfig> = {
  type: "numeric_readout",
  label: "Numeric Readout",
  summarize: (c, ch) => (c.channelId ? channelLabel(c.channelId, ch) : null),
  defaultConfig: { channelId: "", units: "", decimals: 1 },
  ConfigEditor: NumericReadoutConfigEditor,
  Render: NumericReadoutRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { NumericReadoutConfig } from "./render";
