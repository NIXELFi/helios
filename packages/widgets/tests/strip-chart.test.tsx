import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { stripChartWidget } from "../src/strip-chart";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";

function fakeSlice(): ChannelSlice {
  const N = 1000;
  const time = new BigInt64Array(N);
  const rpm = new Float64Array(N);
  for (let i = 0; i < N; i++) { time[i] = BigInt(i * 10_000); rpm[i] = 1000 + i; }
  return { time, data: new Map([["engine.rpm", rpm]]), range: { startUs: 0, endUs: N * 10_000 } };
}

describe("StripChart", () => {
  it("requiredChannels returns configured ids", () => {
    const ids = stripChartWidget.requiredChannels({
      channels: [{ id: "a", color: "#fff" }, { id: "b", color: "#000" }],
      yMin: 0, yMax: 1,
    });
    expect(ids).toEqual(["a", "b"]);
  });

  it("mounts without throwing (jsdom canvas may be limited)", () => {
    // jsdom doesn't implement canvas 2d context fully; uPlot may or may not
    // produce a <canvas>. We just assert the container div exists and the
    // component didn't throw on mount.
    const { container } = render(<stripChartWidget.Render
      config={{ channels: [{ id: "engine.rpm", color: "#FFB800" }], yMin: 0, yMax: 15000 }}
      slice={fakeSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
    />);
    expect(container.querySelector("div")).not.toBeNull();
  });
});
