import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { histogramWidget } from "../src/histogram";
import { CursorEmitter } from "@helios/lib";

describe("Histogram", () => {
  it("renders 'no data' for empty slice", () => {
    const { container } = render(<histogramWidget.Render
      config={{ ...histogramWidget.defaultConfig, channelId: "x" }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("renders bars for non-empty data", () => {
    const x = new Float64Array(1000);
    for (let i = 0; i < 1000; i++) x[i] = Math.sin(i / 50) * 100;
    const { container } = render(<histogramWidget.Render
      config={{ ...histogramWidget.defaultConfig, channelId: "x", bins: 20 }}
      slice={{ time: BigInt64Array.from([0n]), data: new Map([["x", x]]), range: { startUs: 0, endUs: 1 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
