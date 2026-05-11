import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { fftWidget } from "../src/fft";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";

function sineSlice(): ChannelSlice {
  const N = 1024;
  const time = new BigInt64Array(N);
  const v = new Float64Array(N);
  // 200 Hz sine sampled at 1 kHz — gives the FFT something non-trivial to draw.
  for (let i = 0; i < N; i++) {
    time[i] = BigInt(i * 1000); // 1 kHz → 1000 us per sample
    v[i] = Math.sin(2 * Math.PI * 200 * (i / 1000));
  }
  return { time, data: new Map([["engine.rpm", v]]), range: { startUs: 0, endUs: N * 1000 } };
}

describe("FFT", () => {
  it("requiredChannels returns the configured channelId", () => {
    const ids = fftWidget.requiredChannels({
      channelId: "engine.rpm", useZoomRange: false, windowed: true,
      scale: "linear", freqScale: "linear", fmaxHz: 0,
    });
    expect(ids).toEqual(["engine.rpm"]);
  });

  it("sizes its canvas using getBoundingClientRect even when ResizeObserver hasn't fired (M24 regression)", () => {
    // Regression for the ultrareview M24 finding: useResizeObserver can fire
    // with 0×0 on first observation, leaving the canvas blank on first paint.
    // Fix: setupCanvas/canvasLogicalSize fall back to clientWidth/Height (and
    // parent bounding rect) when the rect is 0×0. Here we stub
    // getBoundingClientRect on the canvas (and its parent) to report a real
    // size, then assert the canvas backing-store ends up non-zero.
    const slice = sineSlice();

    // Render into a sized container. jsdom doesn't compute layout, so we
    // stub getBoundingClientRect on every <div>/<canvas> the widget might
    // probe.
    const origGetBcr = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240, width: 320, height: 240, toJSON() { return {}; } } as DOMRect;
    };
    try {
      const { container } = render(<fftWidget.Render
        config={{
          channelId: "engine.rpm", useZoomRange: false, windowed: true,
          scale: "linear", freqScale: "linear", fmaxHz: 0,
        }}
        slice={slice}
        cursorEmitter={new CursorEmitter()}
        timeRange={{ startUs: 0, endUs: 1024 * 1000 }}
      />);
      const canvas = container.querySelector("canvas")!;
      expect(canvas).not.toBeNull();
      // The canvas backing-store width/height should reflect the (stubbed)
      // bounding rect after setupCanvas runs. width/height of 0 would
      // indicate the M24 first-paint blank bug.
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGetBcr;
    }
  });

  it("schedules a redraw via requestAnimationFrame when canvas reports 0×0", () => {
    // Belt-and-suspenders: when layout truly hasn't given the canvas a size
    // yet, the draw fn should bail out and queue a retry on the next frame
    // rather than painting at 0×0 (which leaves the canvas blank forever
    // even after dims arrive).
    const rafCalls: Array<() => void> = [];
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCalls.push(() => cb(0));
      return 0;
    }) as typeof requestAnimationFrame;

    const origGetBcr = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } } as DOMRect;
    };
    try {
      const { container } = render(<fftWidget.Render
        config={{
          channelId: "engine.rpm", useZoomRange: false, windowed: true,
          scale: "linear", freqScale: "linear", fmaxHz: 0,
        }}
        slice={sineSlice()}
        cursorEmitter={new CursorEmitter()}
        timeRange={{ startUs: 0, endUs: 1024 * 1000 }}
      />);
      expect(container.querySelector("canvas")).not.toBeNull();
      // At least one rAF was queued because the first draw saw 0×0.
      expect(rafCalls.length).toBeGreaterThan(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGetBcr;
      globalThis.requestAnimationFrame = origRaf;
    }
  });
});
