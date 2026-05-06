import * as React from "react";
import type { Widget } from "../types";
import { XyPlotConfigEditor } from "./config-editor";
import { XyPlotRender } from "./render";
import type { XyPlotConfig } from "./types";
import { migrateConfig } from "./migrations";

/* The widget instance carries its config through React props. We wrap
 * Render and Editor so any incoming config (from saved workspace, from
 * default, from import) goes through migrateConfig first — that's the
 * one place where v1 → v2 conversion happens. */
function MigratingRender(props: React.ComponentProps<typeof XyPlotRender>) {
  return <XyPlotRender {...props} config={migrateConfig(props.config as never)} />;
}
function MigratingEditor(props: React.ComponentProps<typeof XyPlotConfigEditor>) {
  return <XyPlotConfigEditor {...props} config={migrateConfig(props.config as never)} />;
}

export const xyPlotWidget: Widget<XyPlotConfig> = {
  type: "xy_plot",
  defaultConfig: {
    version: 2,
    mode: "simple",
    xChannelId: "",
    yChannelId: "",
    overlays: [{
      id: "default-scatter",
      kind: "scatter",
      config: { color: "#FFC627", pointSize: 2, alpha: 1, trail: false },
    }],
  },
  ConfigEditor: MigratingEditor,
  Render: MigratingRender,
  requiredChannels: (c) => {
    const m = migrateConfig(c as never);
    const out: string[] = [];
    if (m.xChannelId) out.push(m.xChannelId);
    if (m.yChannelId) out.push(m.yChannelId);
    if (m.groupByChannelId) out.push(m.groupByChannelId);
    return out;
  },
};

export type { XyPlotConfig } from "./types";
