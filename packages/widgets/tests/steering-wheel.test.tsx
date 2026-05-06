import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { steeringWheelWidget } from "../src/steering-wheel";
import { CursorEmitter } from "@helios/lib";

describe("SteeringWheel", () => {
  it("requiredChannels returns the configured channel id", () => {
    expect(steeringWheelWidget.requiredChannels({
      ...steeringWheelWidget.defaultConfig,
      channelId: "chassis.steering_angle",
    })).toEqual(["chassis.steering_angle"]);
  });

  it("requiredChannels is empty when channelId is blank", () => {
    expect(steeringWheelWidget.requiredChannels(steeringWheelWidget.defaultConfig)).toEqual([]);
  });

  it("renders a canvas", () => {
    const { container } = render(<steeringWheelWidget.Render
      config={{ ...steeringWheelWidget.defaultConfig, channelId: "chassis.steering_angle", maxAngle: 120 }}
      slice={{
        time: BigInt64Array.from([0n]),
        data: new Map([["chassis.steering_angle", Float64Array.from([35])]]),
        range: { startUs: 0, endUs: 1 },
      }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
