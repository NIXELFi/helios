import { describe, it, expect, vi } from "vitest";
import { ViewStateEmitter } from "../src/view-state";

describe("ViewStateEmitter", () => {
  it("starts empty: no datums, no zoom", () => {
    const e = new ViewStateEmitter();
    expect(e.get()).toEqual({ datums: [], zoomRange: null });
  });

  it("addDatum keeps timestamps sorted", () => {
    const e = new ViewStateEmitter();
    e.addDatum(500); e.addDatum(100); e.addDatum(300);
    expect(e.get().datums).toEqual([100, 300, 500]);
  });

  it("addDatum dedupes within 1µs of an existing one", () => {
    const e = new ViewStateEmitter();
    e.addDatum(1000);
    e.addDatum(1000);
    e.addDatum(1000.5);
    expect(e.get().datums).toEqual([1000]);
  });

  it("removeDatum removes by approximate match", () => {
    const e = new ViewStateEmitter();
    e.addDatum(100); e.addDatum(200);
    e.removeDatum(100.2);  // within 1µs window
    expect(e.get().datums).toEqual([200]);
  });

  it("clearDatums empties the list", () => {
    const e = new ViewStateEmitter();
    e.addDatum(1); e.addDatum(2);
    e.clearDatums();
    expect(e.get().datums).toEqual([]);
  });

  it("setZoom with valid range stores it", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 100, endUs: 500 });
    expect(e.get().zoomRange).toEqual({ startUs: 100, endUs: 500 });
  });

  it("setZoom with zero/negative width treats as null (guards click-without-drag)", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 200, endUs: 200 });
    expect(e.get().zoomRange).toBeNull();
    e.setZoom({ startUs: 500, endUs: 100 });
    expect(e.get().zoomRange).toBeNull();
  });

  it("resetZoom clears zoom but preserves datums", () => {
    const e = new ViewStateEmitter();
    e.addDatum(123);
    e.setZoom({ startUs: 0, endUs: 1000 });
    e.resetZoom();
    expect(e.get()).toEqual({ datums: [123], zoomRange: null });
  });

  it("subscribers get notified on every state mutation", () => {
    const e = new ViewStateEmitter();
    const cb = vi.fn();
    e.subscribe(cb);
    e.addDatum(10);
    e.setZoom({ startUs: 0, endUs: 100 });
    e.clearDatums();
    e.resetZoom();
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("unsubscribe stops delivery", () => {
    const e = new ViewStateEmitter();
    const cb = vi.fn();
    const off = e.subscribe(cb);
    off();
    e.addDatum(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it("no-op mutations do not notify (clearDatums when empty, removeDatum miss)", () => {
    const e = new ViewStateEmitter();
    const cb = vi.fn();
    e.subscribe(cb);
    e.clearDatums();
    e.removeDatum(9999);
    expect(cb).not.toHaveBeenCalled();
  });
});
