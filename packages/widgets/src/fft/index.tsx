import type { Widget } from "../types";
import { FftConfigEditor } from "./config-editor";
import { FftRender, type FftConfig } from "./render";

export const fftWidget: Widget<FftConfig> = {
  type: "fft",
  defaultConfig: {
    channelId: "engine.rpm",
    useZoomRange: false,
    windowed: true,
    scale: "linear",
    freqScale: "linear",
    fmaxHz: 0,
  },
  ConfigEditor: FftConfigEditor,
  Render: FftRender,
  requiredChannels: (c) => c.channelId ? [c.channelId] : [],
};

export type { FftConfig } from "./render";
