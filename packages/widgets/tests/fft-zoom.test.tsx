import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { ChannelSlice } from "@helios/store";

// Record the length of every window handed to magnitudeSpectrum. That's the
// only externally observable evidence that the FFT actually recomputed over
// the zoom window — the canvas 2d context is a no-op stub under jsdom.
const { windowLengths } = vi.hoisted(() => ({ windowLengths: [] as number[] }));

vi.mock("@helios/lib", async () => {
  const actual = await vi.importActual<typeof import("@helios/lib")>("@helios/lib");
  return {
    ...actual,
    magnitudeSpectrum: (samples: Float64Array, fs: number, windowed: boolean) => {
      windowLengths.push(samples.length);
      return actual.magnitudeSpectrum(samples, fs, windowed);
    },
  };
});

const { fftWidget } = await import("../src/fft");
const { CursorEmitter, ViewStateEmitter } = await import("@helios/lib");

function sineSlice(): ChannelSlice {
  const N = 1024;
  const time = new BigInt64Array(N);
  const v = new Float64Array(N);
  // 200 Hz sine at 1 kHz — 1024 samples spanning 1.024 s.
  for (let i = 0; i < N; i++) {
    time[i] = BigInt(i * 1000);
    v[i] = Math.sin(2 * Math.PI * 200 * (i / 1000));
  }
  return { time, data: new Map([["engine.rpm", v]]), range: { startUs: 0, endUs: N * 1000 } };
}

const BASE_CONFIG = {
  channelId: "engine.rpm", windowed: true,
  scale: "linear" as const, freqScale: "linear" as const, fmaxHz: 0,
};

describe("FFT zoom window", () => {
  beforeEach(() => { windowLengths.length = 0; });

  it("recomputes over the zoomed window when useZoomRange is on", () => {
    // The bug: the spectra memo keyed on the viewState EMITTER, whose identity
    // never changes, so the zoom subscription only redrew the stale spectrum.
    // Zooming appeared to do nothing.
    const viewState = new ViewStateEmitter();
    render(<fftWidget.Render
      config={{ ...BASE_CONFIG, useZoomRange: true }}
      slice={sineSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1024 * 1000 }}
      viewState={viewState}
    />);

    // Full session: pow2Floor(1024) = 1024 samples.
    expect(windowLengths.length).toBeGreaterThan(0);
    expect(windowLengths[windowLengths.length - 1]).toBe(1024);

    const before = windowLengths.length;
    // Zoom to the first 256 ms → 256 samples at 1 kHz.
    act(() => { viewState.setZoom({ startUs: 0, endUs: 256_000 }); });

    expect(windowLengths.length).toBeGreaterThan(before);
    expect(windowLengths[windowLengths.length - 1]).toBe(256);

    // Resetting the zoom goes back to the full window.
    const afterZoom = windowLengths.length;
    act(() => { viewState.resetZoom(); });
    expect(windowLengths.length).toBeGreaterThan(afterZoom);
    expect(windowLengths[windowLengths.length - 1]).toBe(1024);
  });

  it("ignores zoom changes when useZoomRange is off", () => {
    // Opting out must stay free: no recompute of the full-session FFT every
    // time someone drags a zoom box on an unrelated strip chart.
    const viewState = new ViewStateEmitter();
    render(<fftWidget.Render
      config={{ ...BASE_CONFIG, useZoomRange: false }}
      slice={sineSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1024 * 1000 }}
      viewState={viewState}
    />);
    const before = windowLengths.length;
    expect(before).toBeGreaterThan(0);

    act(() => { viewState.setZoom({ startUs: 0, endUs: 256_000 }); });
    expect(windowLengths.length).toBe(before);
  });

  it("does not recompute when an unrelated view-state change lands", () => {
    // Datum drops emit on the same channel; the mirrored zoom is compared by
    // value so they don't churn the memo.
    const viewState = new ViewStateEmitter();
    render(<fftWidget.Render
      config={{ ...BASE_CONFIG, useZoomRange: true }}
      slice={sineSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1024 * 1000 }}
      viewState={viewState}
    />);
    const before = windowLengths.length;

    act(() => { viewState.addDatum(500_000); });
    expect(windowLengths.length).toBe(before);
  });
});
