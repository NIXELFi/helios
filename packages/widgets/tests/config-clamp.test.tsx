/** Numeric widget-config fields that drive work (engine-bar segments, poly-fit
 *  degree) or can throw (decimals → toFixed) are clamped both where they are
 *  typed and where they are used, so a persisted bad value is bounded too. */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";
import {
  clampEditorDecimals, safeDecimals, clampSegments, MAX_SEGMENTS,
} from "../src/lib/config-clamp";
import { numericReadoutWidget } from "../src/numeric-readout";
import { NumericReadoutConfigEditor } from "../src/numeric-readout/config-editor";
import { EngineBarConfigEditor } from "../src/engine-bar/config-editor";
import { engineBarWidget } from "../src/engine-bar";
import { fitOverlay } from "../src/xy-plot/overlays/fit";
import { quadrantFitOverlay } from "../src/xy-plot/overlays/quadrant-fit";
import type { SessionGroup } from "../src/xy-plot/types";

function slice(): ChannelSlice {
  return {
    time: BigInt64Array.from([0n, 10_000n]),
    data: new Map([["engine.rpm", Float64Array.from([1234.5, 2000])]]),
    range: { startUs: 0, endUs: 10_001 },
  };
}

describe("clamp helpers", () => {
  it("clampEditorDecimals → integer in [0, 6]", () => {
    expect(clampEditorDecimals("3")).toBe(3);
    expect(clampEditorDecimals("1000")).toBe(6);
    expect(clampEditorDecimals("-2")).toBe(0);
    expect(clampEditorDecimals("")).toBe(0);
    expect(clampEditorDecimals("2.6")).toBe(3);
  });
  it("safeDecimals keeps any toFixed-safe value", () => {
    expect(safeDecimals(8)).toBe(8);
    expect(safeDecimals(1e9)).toBe(20);
    expect(safeDecimals(-1)).toBe(0);
    expect(safeDecimals(undefined)).toBe(0);
    expect(safeDecimals(NaN)).toBe(0);
  });
  it("clampSegments → integer in [1, 200]", () => {
    expect(clampSegments(30)).toBe(30);
    expect(clampSegments(1e9)).toBe(MAX_SEGMENTS);
    expect(clampSegments("0")).toBe(1);
    expect(clampSegments(NaN)).toBe(30);
  });
});

describe("decimals", () => {
  it("numeric readout renders a persisted out-of-range decimals instead of throwing", () => {
    for (const decimals of [1000, -5, NaN]) {
      const { unmount } = render(<numericReadoutWidget.Render
        config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm", units: "rpm", decimals }}
        slice={slice()}
        cursorEmitter={new CursorEmitter()}
        timeRange={{ startUs: 0, endUs: 10_001 }}
      />);
      unmount();
    }
    render(<numericReadoutWidget.Render
      config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm", units: "rpm", decimals: -5 }}
      slice={slice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 10_001 }}
    />);
    expect(screen.getByText("1235")).toBeDefined();
  });

  it("numeric readout editor clamps typed decimals", () => {
    const onChange = vi.fn();
    const { container } = render(<NumericReadoutConfigEditor
      config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm" }}
      onChange={onChange}
      availableChannels={[]}
    />);
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "500" } });
    expect(onChange.mock.calls.at(-1)![0].decimals).toBe(6);
  });
});

describe("engine-bar segments", () => {
  it("editor clamps typed segments", () => {
    const onChange = vi.fn();
    const { container } = render(<EngineBarConfigEditor
      config={{ ...engineBarWidget.defaultConfig }}
      onChange={onChange}
      availableChannels={[]}
    />);
    const inputs = container.querySelectorAll('input[type="number"]');
    const segs = inputs[inputs.length - 1] as HTMLInputElement;
    fireEvent.change(segs, { target: { value: "100000000" } });
    expect(onChange.mock.calls.at(-1)![0].segments).toBe(MAX_SEGMENTS);
  });
});

describe("polynomial fit degree", () => {
  const xs = Float64Array.from({ length: 50 }, (_, i) => i / 10 + 0.1);
  const ys = Float64Array.from(xs, (x) => 1 + 2 * x + 3 * x * x);
  const group: SessionGroup = {
    session: { id: "s", label: "s", color: "#FFC627",
               range: { startUs: 0, endUs: 1 }, isPrimary: true,
               slice: { time: BigInt64Array.from([0n]), data: new Map(), range: { startUs: 0, endUs: 1 } } },
    groupKey: "", color: "#FFC627", time: xs, xs, ys, n: xs.length,
  };
  const ctx = { bounds: { xmin: 0, xmax: 5, ymin: 0, ymax: 100 }, priorArtifacts: new Map(), availableChannels: [] };

  it("a persisted huge degree is clamped to 6 at render (fits, bounded work)", () => {
    const cfg = { ...fitOverlay.defaultConfig(), kind: { type: "polynomial" as const, degree: 1e7 } };
    const art = fitOverlay.compute([group], cfg, ctx);
    expect(art.fits).toHaveLength(1);
    expect(art.fits[0]!.coefficients).toHaveLength(7);
    expect(fitOverlay.legendEntries!(cfg, art)[0]!.label).toMatch(/poly d=6/);
  });

  it("quadrant fit clamps a persisted degree too", () => {
    const cfg = { ...quadrantFitOverlay.defaultConfig(), kind: { type: "polynomial" as const, degree: -3 } };
    const art = quadrantFitOverlay.compute([group], cfg, ctx);
    expect(art.quadrants[0]!.coefficients).toHaveLength(2); // degree 1
  });

  it("the degree input clamps what is typed", () => {
    const onChange = vi.fn();
    const Editor = fitOverlay.Editor!;
    const { container } = render(<Editor
      config={{ ...fitOverlay.defaultConfig(), kind: { type: "polynomial", degree: 2 } }}
      onChange={onChange}
      availableChannels={[]}
      siblings={[]}
    />);
    const deg = container.querySelector('input[type="number"][min="1"]') as HTMLInputElement;
    fireEvent.change(deg, { target: { value: "99" } });
    expect(onChange.mock.calls.at(-1)![0].kind).toEqual({ type: "polynomial", degree: 6 });
  });
});
