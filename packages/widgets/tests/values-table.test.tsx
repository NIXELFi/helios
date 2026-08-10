import { afterEach, describe, it, expect } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CursorEmitter, ViewStateEmitter } from "@helios/lib";
import type { ChannelMeta, ChannelSlice } from "@helios/store";
import { valuesTableWidget } from "../src/values-table";
import type { OverlaySession } from "../src/types";

function makeSlice(vals: Record<string, (i: number) => number>, n = 11): ChannelSlice {
  const time = new BigInt64Array(n);
  for (let i = 0; i < n; i++) time[i] = BigInt(i * 100_000); // 10 Hz
  const data = new Map<string, Float64Array>();
  for (const [id, f] of Object.entries(vals)) {
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = f(i);
    data.set(id, arr);
  }
  return { time, data, range: { startUs: 0, endUs: (n - 1) * 100_000 } };
}

function overlay(id: string, slice: ChannelSlice, isPrimary: boolean, color = "#FFC627"): OverlaySession {
  return { id, label: id, color, slice, range: slice.range, isPrimary };
}

function chMeta(over: Partial<ChannelMeta>): ChannelMeta {
  return {
    id: "engine.rpm", display_name: "RPM", units: "rpm", group: "Engine",
    color: "#FFC627", decimals: 0, data_type: "f64", source: "csv",
    sample_rate_hz: 100,
    ...over,
  };
}

const EMPTY_SLICE: ChannelSlice = {
  time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 },
};

describe("valuesTableWidget", () => {
  // The shared setup doesn't enable testing-library auto-cleanup (no vitest
  // globals); without this, trees from earlier tests accumulate in the same
  // jsdom document and text queries collide across renders.
  afterEach(cleanup);

  it("registers with the expected defaults", () => {
    expect(valuesTableWidget.type).toBe("values_table");
    expect(valuesTableWidget.defaultConfig).toEqual({ channelIds: [], showStats: true });
    expect(valuesTableWidget.requiredChannels({ channelIds: ["a", "b"], showStats: true }))
      .toEqual(["a", "b"]);
  });

  it("shows the add-channels empty state when no channels are configured", () => {
    render(<valuesTableWidget.Render
      config={valuesTableWidget.defaultConfig}
      slice={EMPTY_SLICE}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText(/no channels configured/i)).toBeDefined();
  });

  it("renders cursor value and min/max/avg stats for the primary session", () => {
    const slice = makeSlice({ "engine.rpm": (i) => i * 2 });
    render(<valuesTableWidget.Render
      config={{ channelIds: ["engine.rpm"], showStats: true }}
      slice={slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={slice.range}
    />);
    // No availableChannels → raw id, 2-decimal fallback.
    expect(screen.getByText("engine.rpm")).toBeDefined();
    expect(screen.getByText("min")).toBeDefined();
    expect(screen.getByText("max")).toBeDefined();
    expect(screen.getByText("avg")).toBeDefined();
    // Cursor at t=0 → 0.00 (also the min → two cells).
    expect(screen.getAllByText("0.00").length).toBe(2);
    expect(screen.getByText("20.00")).toBeDefined(); // max
    expect(screen.getByText("10.00")).toBeDefined(); // avg
  });

  it("formats with host-supplied channel metadata (name, units, decimals)", () => {
    const slice = makeSlice({ "engine.rpm": (i) => i * 2 });
    render(<valuesTableWidget.Render
      config={{ channelIds: ["engine.rpm"], showStats: true }}
      slice={slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={slice.range}
      availableChannels={[chMeta({ decimals: 0 })]}
    />);
    expect(screen.getByText("RPM")).toBeDefined();
    expect(screen.getByText("rpm")).toBeDefined();
    expect(screen.getByText("20")).toBeDefined(); // max at 0 decimals
    expect(screen.queryByText("engine.rpm")).toBeNull();
  });

  it("hides stats columns when showStats is off", () => {
    const slice = makeSlice({ "engine.rpm": (i) => i });
    render(<valuesTableWidget.Render
      config={{ channelIds: ["engine.rpm"], showStats: false }}
      slice={slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={slice.range}
    />);
    expect(screen.queryByText("min")).toBeNull();
    expect(screen.queryByText("avg")).toBeNull();
  });

  it("shows a tinted Δ-vs-primary column per non-primary session", () => {
    const p = makeSlice({ "engine.rpm": () => 100 });
    const o = makeSlice({ "engine.rpm": () => 103 });
    render(<valuesTableWidget.Render
      config={{ channelIds: ["engine.rpm"], showStats: false }}
      slice={p}
      cursorEmitter={new CursorEmitter()}
      timeRange={p.range}
      overlays={[overlay("main", p, true), overlay("ref", o, false, "#4FC3F7")]}
    />);
    expect(screen.getByText("Δ")).toBeDefined();
    expect(screen.getByText("100.00")).toBeDefined();
    expect(screen.getByText("103.00")).toBeDefined();
    const delta = screen.getByText("+3.00");
    expect(delta).toBeDefined();
    expect((delta as HTMLElement).style.color).toBe("rgb(239, 83, 80)"); // #EF5350
  });

  it("renders — dimmed for channels a session doesn't carry", () => {
    const p = makeSlice({ "engine.rpm": () => 100 });
    const o = makeSlice({ other: () => 1 });
    render(<valuesTableWidget.Render
      config={{ channelIds: ["engine.rpm"], showStats: false }}
      slice={p}
      cursorEmitter={new CursorEmitter()}
      timeRange={p.range}
      overlays={[overlay("main", p, true), overlay("ref", o, false)]}
    />);
    // Missing value cell + missing delta cell.
    expect(screen.getAllByText("—").length).toBe(2);
  });

  it("recomputes stats when the zoom window changes", () => {
    const slice = makeSlice({ "engine.rpm": (i) => i });
    const viewState = new ViewStateEmitter();
    render(<valuesTableWidget.Render
      config={{ channelIds: ["engine.rpm"], showStats: true }}
      slice={slice}
      cursorEmitter={new CursorEmitter()}
      timeRange={slice.range}
      viewState={viewState}
    />);
    // Full extent: max 10.00, avg 5.00.
    expect(screen.getByText("10.00")).toBeDefined();
    expect(screen.getByText("5.00")).toBeDefined();

    // Zoom to the first 500 ms → samples 0..5 → max 5.00, avg 2.50.
    act(() => { viewState.setZoom({ startUs: 0, endUs: 500_000 }); });
    expect(screen.queryByText("10.00")).toBeNull();
    expect(screen.getByText("2.50")).toBeDefined();

    // Reset returns to the full extent.
    act(() => { viewState.resetZoom(); });
    expect(screen.getByText("10.00")).toBeDefined();
  });
});
