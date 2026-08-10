import type { Widget } from "../types";
import { SteeringWheelConfigEditor } from "./config-editor";
import { SteeringWheelRender, type SteeringWheelConfig } from "./render";

export const steeringWheelWidget: Widget<SteeringWheelConfig> = {
  type: "steering_wheel",
  label: "Steering Wheel",
  defaultConfig: { channelId: "", units: "°", maxAngle: 90, invert: false },
  ConfigEditor: SteeringWheelConfigEditor,
  Render: SteeringWheelRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { SteeringWheelConfig } from "./render";
