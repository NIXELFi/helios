import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { lapPanelWidget } from "../src/lap-panel";
import { CursorEmitter } from "@helios/lib";

describe("LapPanel", () => {
  it("shows 'no laps detected' when empty", () => {
    render(<lapPanelWidget.Render
      config={{ laps: [] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("no laps detected")).toBeDefined();
  });

  it("renders laps and highlights the fastest", () => {
    render(<lapPanelWidget.Render
      config={{ laps: [
        { number: 1, time_ms: 75432 },
        { number: 2, time_ms: 74100 },
        { number: 3, time_ms: 75999 },
      ] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("1:14.100")).toBeDefined();
    expect(screen.getByText("1:15.432")).toBeDefined();
  });
});
