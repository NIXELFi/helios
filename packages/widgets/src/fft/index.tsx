import type { Widget } from "../types";
import { channelLabel } from "../lib/display-meta";
import { FftConfigEditor } from "./config-editor";
import { FftRender, type FftConfig } from "./render";

export const fftWidget: Widget<FftConfig> = {
  type: "fft",
  label: "FFT / Spectrum",
  summarize: (c, ch) => (c.channelId ? channelLabel(c.channelId, ch) : null),
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
