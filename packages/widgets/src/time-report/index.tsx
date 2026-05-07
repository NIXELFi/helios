import type { Widget } from "../types";
import { TimeReportConfigEditor } from "./config-editor";
import { TimeReportRender, type TimeReportConfig } from "./render";

export const timeReportWidget: Widget<TimeReportConfig> = {
  type: "time_report",
  defaultConfig: {
    perSession: false,
    hideUntrusted: true,
    rollingWindow: 3,
  },
  ConfigEditor: TimeReportConfigEditor,
  Render: TimeReportRender,
  requiredChannels: () => [],
};

export type { TimeReportConfig } from "./render";
