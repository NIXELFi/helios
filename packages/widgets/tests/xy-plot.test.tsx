import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { xyPlotWidget } from "../src/xy-plot";
import { CursorEmitter } from "@helios/lib";

describe("XyPlot", () => {
  it("renders 'no data' when channels missing", () => {
    const { container } = render(<xyPlotWidget.Render
      config={{ ...xyPlotWidget.defaultConfig, xChannelId: "a", yChannelId: "b" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders points for valid data", () => {
    const a = Float64Array.from([0, 1, 2, 3, 4]);
    const b = Float64Array.from([0, 1, 4, 9, 16]);
    const { container } = render(<xyPlotWidget.Render
      config={{ ...xyPlotWidget.defaultConfig, xChannelId: "a", yChannelId: "b" }}
      slice={{ time: BigInt64Array.from([0n, 1n, 2n, 3n, 4n]), data: new Map([["a", a], ["b", b]]), range: { startUs: 0, endUs: 5 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 5 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
