import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { numericReadoutWidget } from "../src/numeric-readout";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";

function fakeSlice(): ChannelSlice {
  return {
    time: BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n]),
    data: new Map([["engine.rpm", Float64Array.from([1000, 2000, 3000, 4000])]]),
    range: { startUs: 0, endUs: 30_001 },
  };
}

describe("NumericReadout", () => {
  let cursor: CursorEmitter;
  beforeEach(() => { cursor = new CursorEmitter(); });

  it("renders the value at cursor=0 initially", () => {
    render(<numericReadoutWidget.Render
      config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm", units: "rpm", decimals: 0 }}
      slice={fakeSlice()}
      cursorEmitter={cursor}
      timeRange={{ startUs: 0, endUs: 30_001 }}
    />);
    expect(screen.getByText("1000")).toBeDefined();
    expect(screen.getByText("rpm")).toBeDefined();
  });

  it("updates the value when the cursor moves", async () => {
    render(<numericReadoutWidget.Render
      config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm", units: "rpm", decimals: 0 }}
      slice={fakeSlice()}
      cursorEmitter={cursor}
      timeRange={{ startUs: 0, endUs: 30_001 }}
    />);
    act(() => { cursor.emit(20_000); });
    expect(screen.getByText("3000")).toBeDefined();
  });
});
