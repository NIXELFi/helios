import type { Widget } from "../types";
import { ValuesTableConfigEditor } from "./config-editor";
import { ValuesTableRender, type ValuesTableConfig } from "./render";

export const valuesTableWidget: Widget<ValuesTableConfig> = {
  type: "values_table",
  defaultConfig: {
    channelIds: [],
    showStats: true,
  },
  ConfigEditor: ValuesTableConfigEditor,
  Render: ValuesTableRender,
  requiredChannels: (c) => c.channelIds,
};

export type { ValuesTableConfig } from "./render";
