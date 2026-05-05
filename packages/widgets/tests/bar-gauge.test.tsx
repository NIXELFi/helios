import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { barGaugeWidget } from "../src/bar-gauge";
import { CursorEmitter } from "@helios/lib";

describe("BarGauge", () => {
  it("renders a canvas (vertical)", () => {
    const { container } = render(<barGaugeWidget.Render
      config={{ ...barGaugeWidget.defaultConfig, channelId: "x", units: "u", min: 0, max: 100, orientation: "vertical" }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["x", Float64Array.from([42])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders a canvas (horizontal)", () => {
    const { container } = render(<barGaugeWidget.Render
      config={{ ...barGaugeWidget.defaultConfig, channelId: "x", units: "u", min: 0, max: 100, orientation: "horizontal" }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["x", Float64Array.from([42])]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
