import type { Widget } from "../types";
import { EngineBarConfigEditor } from "./config-editor";
import { EngineBarRender, type EngineBarConfig } from "./render";

export const engineBarWidget: Widget<EngineBarConfig> = {
  type: "engine_bar",
  defaultConfig: { rpmChannelId: "engine.rpm", redline: 14000, shiftLightStart: 12000, segments: 30 },
  ConfigEditor: EngineBarConfigEditor,
  Render: EngineBarRender,
  requiredChannels: (c) => [c.rpmChannelId, c.gearChannelId].filter((x): x is string => Boolean(x)),
};

export type { EngineBarConfig } from "./render";
