import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { alarmPanelWidget } from "../src/alarm-panel";
import { CursorEmitter } from "@helios/lib";

describe("AlarmPanel", () => {
  it("shows 'no alarms' when empty", () => {
    render(<alarmPanelWidget.Render
      config={{ alarms: [] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("no alarms")).toBeDefined();
  });

  it("renders alarms with severity color", () => {
    render(<alarmPanelWidget.Render
      config={{ alarms: [
        { id: "a1", severity: "warn", channel: "engine.water_temp", value: 108, message: "above warn", t_us: 12_345_000 },
        { id: "a2", severity: "critical", channel: "engine.oil_temp", value: 138, message: "above alarm", t_us: 23_456_000 },
      ] }}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("● engine.water_temp")).toBeDefined();
    expect(screen.getByText("● engine.oil_temp")).toBeDefined();
  });
});
