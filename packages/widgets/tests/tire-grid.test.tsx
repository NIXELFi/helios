import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { tireGridWidget } from "../src/tire-grid";
import { CursorEmitter } from "@helios/lib";

describe("TireGrid", () => {
  it("renders all four corners", () => {
    render(<tireGridWidget.Render
      config={tireGridWidget.defaultConfig}
      slice={{ time: new BigInt64Array(0), data: new Map(), range: { startUs: 0, endUs: 0 } }}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 0 }}
    />);
    expect(screen.getByText("LF")).toBeDefined();
    expect(screen.getByText("RF")).toBeDefined();
    expect(screen.getByText("LR")).toBeDefined();
    expect(screen.getByText("RR")).toBeDefined();
  });

  it("requiredChannels lists all configured channel ids", () => {
    const cfg = {
      ...tireGridWidget.defaultConfig,
      tempChannels: { lf: "lf.t", rf: "rf.t", lr: "lr.t", rr: "rr.t" } as const,
      pressureChannels: { lf: "lf.p", rf: "rf.p", lr: "lr.p", rr: "rr.p" } as const,
    };
    expect(tireGridWidget.requiredChannels(cfg).length).toBe(8);
  });
});
