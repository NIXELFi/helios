import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { roundGaugeWidget } from "../src/round-gauge";
import { CursorEmitter } from "@helios/lib";

describe("RoundGauge", () => {
  it("requiredChannels returns the channel id", () => {
    expect(roundGaugeWidget.requiredChannels({
      ...roundGaugeWidget.defaultConfig,
      channelId: "engine.water_temp",
    })).toEqual(["engine.water_temp"]);
  });

  it("renders a canvas", () => {
    const { container } = render(<roundGaugeWidget.Render
      config={{ ...roundGaugeWidget.defaultConfig, channelId: "engine.water_temp", units: "°C", decimals: 1, min: 0, max: 130, warn: 105, alarm: 115 }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["engine.water_temp", Float64Array.from([90])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
