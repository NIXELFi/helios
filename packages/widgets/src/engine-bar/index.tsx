import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { EngineBarConfigEditor } from "./config-editor";
import { EngineBarRender, type EngineBarConfig } from "./render";

export const engineBarWidget: Widget<EngineBarConfig> = {
  type: "engine_bar",
  label: "Engine Bar",
  summarize: (c, ch) => (c.rpmChannelId ? channelLabel(c.rpmChannelId, ch) : null),
  defaultConfig: { rpmChannelId: "engine.rpm", redline: 14000, shiftLightStart: 12000, segments: 30 },
  ConfigEditor: EngineBarConfigEditor,
  Render: EngineBarRender,
  requiredChannels: (c) => [c.rpmChannelId, c.gearChannelId].filter((x): x is string => Boolean(x)),
};

export type { EngineBarConfig } from "./render";
