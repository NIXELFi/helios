import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { stripChartWidget } from "../src/strip-chart";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";

// Spy on uPlot construction so we can assert how many instances are built
// across re-renders. The actual uPlot module is preserved so behavior is
// unchanged; we only intercept the constructor to count invocations.
const uplotConstructSpy = vi.fn();
vi.mock("uplot", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await vi.importActual("uplot")) as any;
  const Real = actual.default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function SpiedUPlot(this: unknown, ...args: any[]): any {
    uplotConstructSpy();
    return new Real(...args);
  }
  // Preserve static members (uPlot.sync, uPlot.paths, etc).
  Object.assign(SpiedUPlot, Real);
  SpiedUPlot.prototype = Real.prototype;
  return { ...actual, default: SpiedUPlot };
});

function fakeSlice(seed = 0): ChannelSlice {
  const N = 1000;
  const time = new BigInt64Array(N);
  const rpm = new Float64Array(N);
  for (let i = 0; i < N; i++) { time[i] = BigInt(i * 10_000); rpm[i] = 1000 + i + seed; }
  return { time, data: new Map([["engine.rpm", rpm]]), range: { startUs: 0, endUs: N * 10_000 } };
}

describe("StripChart", () => {
  beforeEach(() => { uplotConstructSpy.mockClear(); });

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

  it("does NOT recreate uPlot when only the data slice changes (M14 regression)", () => {
    // Regression for the M14 ultrareview finding: previously the effect that
    // built the uPlot instance had `slice` in its dep array, so any parent
    // render (which always allocates a fresh slice reference) destroyed and
    // re-created the chart — including mid pointer-drag. After the split-
    // effect fix, only data changes flow through setData and the same
    // uPlot instance is reused.
    const config = { channels: [{ id: "engine.rpm", color: "#FFB800" }], yMin: 0, yMax: 15000 };
    const cursorEmitter = new CursorEmitter();
    const timeRange = { startUs: 0, endUs: 1_000 * 10_000 };
    const { rerender } = render(<stripChartWidget.Render
      config={config}
      slice={fakeSlice(0)}
      cursorEmitter={cursorEmitter}
      timeRange={timeRange}
    />);
    const initialConstructs = uplotConstructSpy.mock.calls.length;
    // uPlot may or may not be constructed under jsdom (canvas is stubbed).
    // The contract we care about is: the construct count after subsequent
    // data-only re-renders stays equal to the initial count.

    // Re-render multiple times with different slices, same config + range.
    rerender(<stripChartWidget.Render
      config={config}
      slice={fakeSlice(1)}
      cursorEmitter={cursorEmitter}
      timeRange={timeRange}
    />);
    rerender(<stripChartWidget.Render
      config={config}
      slice={fakeSlice(2)}
      cursorEmitter={cursorEmitter}
      timeRange={timeRange}
    />);
    rerender(<stripChartWidget.Render
      config={config}
      slice={fakeSlice(3)}
      cursorEmitter={cursorEmitter}
      timeRange={timeRange}
    />);
    expect(uplotConstructSpy.mock.calls.length).toBe(initialConstructs);
  });

  it("shows live cursor readout values per channel and updates on cursor emit", () => {
    // Slice has engine.rpm = 1000 + i for i in [0..1000), one sample every
    // 10ms. At t=0us → 1000; at t=500_000us (sample 50) → 1050;
    // at t=999_990us (last sample) → 1999.
    const slice = fakeSlice(0);
    const cursorEmitter = new CursorEmitter();
    const { container } = render(<stripChartWidget.Render
      config={{ channels: [{ id: "engine.rpm", color: "#FFB800" }], yMin: 0, yMax: 15000 }}
      slice={slice}
      cursorEmitter={cursorEmitter}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
    />);

    const readout = container.querySelector('[data-testid="strip-chart-readout-value-primary-engine.rpm"]');
    expect(readout).not.toBeNull();
    // Initial seed at cursor=0 should read sample 0 → 1000.
    expect(readout!.textContent).toBe("1000");

    // Emit cursor at sample 500 → value 1500.
    act(() => { cursorEmitter.emit(500 * 10_000); });
    expect(readout!.textContent).toBe("1500");

    // Emit cursor at last sample → value 1999.
    act(() => { cursorEmitter.emit(999 * 10_000); });
    expect(readout!.textContent).toBe("1999");
  });

  it("x-mode pill is a plain span when the host passes no onConfigChange", () => {
    // Read-only hosts (embeds, previews) can't persist config, so the pill
    // must degrade to a display-only read-out rather than a dead button.
    const { container } = render(<stripChartWidget.Render
      config={{ channels: [{ id: "engine.rpm", color: "#FFB800" }], yMin: 0, yMax: 15000 }}
      slice={fakeSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
    />);
    const pill = container.querySelector('[data-testid="strip-chart-xmode"]')!;
    expect(pill).not.toBeNull();
    expect(pill.tagName).toBe("SPAN");
    expect(pill.textContent).toBe("x = time");
  });

  it("x-mode pill toggles time↔distance through onConfigChange", () => {
    // The pill used to be a non-interactive span despite a comment claiming
    // it toggled the axis mode.
    const onConfigChange = vi.fn();
    const config = {
      channels: [{ id: "engine.rpm", color: "#FFB800" }],
      yMin: 0, yMax: 15000,
    };
    const { container, rerender } = render(<stripChartWidget.Render
      config={config}
      slice={fakeSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
      onConfigChange={onConfigChange}
    />);
    const pill = container.querySelector('[data-testid="strip-chart-xmode"]')!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.textContent).toBe("x = time");

    fireEvent.click(pill);
    // Unset xMode defaults to time, so the first flip goes to distance and
    // the rest of the config rides along untouched.
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange.mock.calls[0]![0]).toEqual({ ...config, xMode: "distance" });

    // Host persists it and re-renders; the pill now flips back to time.
    const distanceConfig = { ...config, xMode: "distance" as const };
    rerender(<stripChartWidget.Render
      config={distanceConfig}
      slice={fakeSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
      onConfigChange={onConfigChange}
    />);
    const pill2 = container.querySelector('[data-testid="strip-chart-xmode"]')!;
    expect(pill2.textContent).toBe("x = distance");
    fireEvent.click(pill2);
    expect(onConfigChange).toHaveBeenCalledTimes(2);
    expect(onConfigChange.mock.calls[1]![0]).toEqual({ ...config, xMode: "time" });
  });

  it("renders em-dash for empty channel id (placeholder row before user configures)", () => {
    const cursorEmitter = new CursorEmitter();
    const { container } = render(<stripChartWidget.Render
      config={{ channels: [{ id: "", color: "#FFB800" }], yMin: 0, yMax: 15000 }}
      slice={fakeSlice()}
      cursorEmitter={cursorEmitter}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
    />);
    // Channel with empty id renders the row but the value is "—".
    const valueSpans = container.querySelectorAll('[data-testid^="strip-chart-readout-value-"]');
    expect(valueSpans.length).toBe(1);
    expect(valueSpans[0]!.textContent).toBe("—");
  });
});
