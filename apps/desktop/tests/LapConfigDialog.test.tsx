import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

// LapConfigDialog pulls in @helios/widgets (ChannelPicker), whose barrel
// imports maplibre-gl; maplibre's module init calls window.URL.createObjectURL,
// which jsdom lacks. Stub it before the component is imported.
vi.hoisted(() => {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:stub";
    URL.revokeObjectURL = () => {};
  }
});

import { ChannelStore } from "@helios/store";
import { GpsPickerEmitter } from "@helios/lib";
import type { LapDetectionConfig } from "@helios/lib";
import { LapConfigDialog, coalesceNum, parseManualCrossingsUs } from "../src/components/LapConfigDialog";
import type { LoadedSession } from "../src/lib/session";

afterEach(cleanup);

describe("coalesceNum", () => {
  it("passes through a finite number", () => {
    expect(coalesceNum(42, 7)).toBe(42);
    expect(coalesceNum(0, 7)).toBe(0);
    expect(coalesceNum(-3.5, 7)).toBe(-3.5);
  });
  it("falls back to prev for NaN", () => {
    expect(coalesceNum(NaN, 7)).toBe(7);
    expect(coalesceNum(Number("abc"), 30)).toBe(30);
  });
  it("falls back to prev for Infinity", () => {
    expect(coalesceNum(Infinity, 5)).toBe(5);
    expect(coalesceNum(-Infinity, 5)).toBe(5);
  });
  it("guards against Math.max(1, NaN) poisoning the radius", () => {
    // The component does Math.max(1, coalesceNum(...)); verify the inner call
    // never yields NaN so the outer Math.max stays finite.
    expect(Math.max(1, coalesceNum(NaN, 30))).toBe(30);
    expect(Number.isFinite(Math.max(1, coalesceNum(Number("x"), 30)))).toBe(true);
  });
});

describe("parseManualCrossingsUs", () => {
  it("sorts ascending", () => {
    expect(parseManualCrossingsUs("131.85\n12.45\n72.10")).toEqual([
      12_450_000, 72_100_000, 131_850_000,
    ]);
  });
  it("dedupes repeated crossings", () => {
    expect(parseManualCrossingsUs("72.10\n72.10\n12.45")).toEqual([
      12_450_000, 72_100_000,
    ]);
  });
  it("accepts comma- and newline-separated values", () => {
    expect(parseManualCrossingsUs("12.45, 72.10\n131.85")).toEqual([
      12_450_000, 72_100_000, 131_850_000,
    ]);
  });
  it("drops blank/non-numeric tokens", () => {
    expect(parseManualCrossingsUs("12.45\n\n  \n72.10")).toEqual([
      12_450_000, 72_100_000,
    ]);
  });
});

function makeSession(lapConfig: LapDetectionConfig): LoadedSession {
  return {
    id: "s1",
    label: "Session 1",
    store: new ChannelStore(),
    color: "#FFC627",
    visible: true,
    lapConfig,
    laps: null,
    channelOverrides: {},
  };
}

function setup(lapConfig: LapDetectionConfig) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const emitter = new GpsPickerEmitter();
  render(
    <LapConfigDialog
      session={makeSession(lapConfig)}
      gpsPickerEmitter={emitter}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  return { onSave, onClose };
}

describe("LapConfigDialog — manual crossings", () => {
  it("sorts and dedupes manual crossings before saving", () => {
    const { onSave } = setup({ mode: "manual", manual: { crossingsUs: [] } });
    const textarea = screen.getByPlaceholderText(/12\.45/i) as HTMLTextAreaElement;
    // Out of order, with a duplicate (72.10 twice).
    fireEvent.change(textarea, { target: { value: "131.85\n12.45\n72.10\n72.10" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as LapDetectionConfig;
    expect(saved.manual!.crossingsUs).toEqual([
      12_450_000, 72_100_000, 131_850_000,
    ]);
  });
});

describe("LapConfigDialog — numeric NaN coalescing", () => {
  it("a non-numeric radius coalesces to a finite value (not Math.max(1, NaN))", () => {
    const cfg: LapDetectionConfig = {
      mode: "gps_line",
      gpsLine: { latChannelId: "gps.lat", lonChannelId: "gps.lon", centerLat: 33, centerLon: -111, radiusM: 30 },
    };
    const { onSave } = setup(cfg);
    const radius = document.querySelector('input[min="1"]') as HTMLInputElement;
    fireEvent.change(radius, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const saved = onSave.mock.calls[0]![0] as LapDetectionConfig;
    expect(Number.isFinite(saved.gpsLine!.radiusM)).toBe(true);
    expect(saved.gpsLine!.radiusM).toBeGreaterThanOrEqual(1);
  });

  it("a non-numeric centerLat keeps the prior finite value (no NaN)", () => {
    const cfg: LapDetectionConfig = {
      mode: "gps_line",
      gpsLine: { latChannelId: "gps.lat", lonChannelId: "gps.lon", centerLat: 33.5, centerLon: -111.9, radiusM: 30 },
    };
    const { onSave } = setup(cfg);
    const latInput = screen.getByDisplayValue("33.5") as HTMLInputElement;
    fireEvent.change(latInput, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const saved = onSave.mock.calls[0]![0] as LapDetectionConfig;
    expect(Number.isFinite(saved.gpsLine!.centerLat)).toBe(true);
  });

  it("a non-numeric beacon threshold keeps a finite value (no NaN)", () => {
    const cfg: LapDetectionConfig = {
      mode: "beacon",
      beacon: { channelId: "system.beacon", threshold: 0.5 },
    };
    const { onSave } = setup(cfg);
    const thr = screen.getByDisplayValue("0.5") as HTMLInputElement;
    fireEvent.change(thr, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const saved = onSave.mock.calls[0]![0] as LapDetectionConfig;
    expect(Number.isFinite(saved.beacon!.threshold)).toBe(true);
  });
});

describe("LapConfigDialog — modal a11y", () => {
  it("Escape closes the dialog", () => {
    const { onClose } = setup({ mode: "none" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
