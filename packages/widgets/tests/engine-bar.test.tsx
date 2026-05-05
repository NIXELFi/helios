import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { engineBarWidget } from "../src/engine-bar";
import { CursorEmitter } from "@helios/lib";

describe("EngineBar", () => {
  it("requiredChannels includes rpm and gear when both set", () => {
    expect(engineBarWidget.requiredChannels({
      rpmChannelId: "engine.rpm", gearChannelId: "engine.gear",
      redline: 14000, shiftLightStart: 12000, segments: 30,
    })).toEqual(["engine.rpm", "engine.gear"]);
  });

  it("renders a canvas", () => {
    const { container } = render(<engineBarWidget.Render
      config={{ rpmChannelId: "engine.rpm", redline: 14000, shiftLightStart: 12000, segments: 30 }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["engine.rpm", Float64Array.from([8000])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
