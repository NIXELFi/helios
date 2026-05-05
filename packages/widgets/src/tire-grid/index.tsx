import type { Widget } from "../types";
import { TireGridConfigEditor } from "./config-editor";
import { TireGridRender, type TireGridConfig } from "./render";

export const tireGridWidget: Widget<TireGridConfig> = {
  type: "tire_grid",
  defaultConfig: {
    tempChannels: { lf: "", rf: "", lr: "", rr: "" },
    pressureChannels: { lf: "", rf: "", lr: "", rr: "" },
    tempMin: 60, tempMax: 110, tempCool: 75, tempHot: 100,
  },
  ConfigEditor: TireGridConfigEditor,
  Render: TireGridRender,
  requiredChannels: (c) => [
    ...Object.values(c.tempChannels),
    ...Object.values(c.pressureChannels),
    ...(c.wearChannels ? Object.values(c.wearChannels) : []),
  ].filter(Boolean),
};

export type { TireGridConfig } from "./render";
