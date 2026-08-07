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

describe("ViewStateEmitter zoom stack", () => {
  it("setZoom pushes the previous range onto the stack", () => {
    const e = new ViewStateEmitter();
    expect(e.zoomStackDepth()).toBe(0);
    e.setZoom({ startUs: 0, endUs: 1000 });
    expect(e.zoomStackDepth()).toBe(1);   // pushed the initial null
    e.setZoom({ startUs: 100, endUs: 500 });
    expect(e.zoomStackDepth()).toBe(2);
  });

  it("popZoom restores the previous range and reports success", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 0, endUs: 1000 });
    e.setZoom({ startUs: 100, endUs: 500 });
    expect(e.popZoom()).toBe(true);
    expect(e.get().zoomRange).toEqual({ startUs: 0, endUs: 1000 });
    expect(e.popZoom()).toBe(true);
    expect(e.get().zoomRange).toBeNull();  // back to the full view
  });

  it("popZoom on an empty stack returns false and changes nothing", () => {
    const e = new ViewStateEmitter();
    const cb = vi.fn();
    e.subscribe(cb);
    expect(e.popZoom()).toBe(false);
    expect(e.get().zoomRange).toBeNull();
    expect(cb).not.toHaveBeenCalled();
  });

  it("popZoom does not itself push, so undo walks back instead of ping-ponging", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 0, endUs: 1000 });
    e.setZoom({ startUs: 100, endUs: 500 });
    e.popZoom();
    expect(e.zoomStackDepth()).toBe(1);
    e.popZoom();
    expect(e.zoomStackDepth()).toBe(0);
    expect(e.popZoom()).toBe(false);
  });

  it("resetZoom is undoable — popZoom restores the range it cleared", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 200, endUs: 800 });
    e.resetZoom();
    expect(e.get().zoomRange).toBeNull();
    expect(e.popZoom()).toBe(true);
    expect(e.get().zoomRange).toEqual({ startUs: 200, endUs: 800 });
  });

  it("redundant setZoom (same value, different object) does not grow the stack", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 0, endUs: 1000 });
    expect(e.zoomStackDepth()).toBe(1);
    e.setZoom({ startUs: 0, endUs: 1000 });
    e.setZoom({ startUs: 0, endUs: 1000 });
    expect(e.zoomStackDepth()).toBe(1);
    expect(e.get().zoomRange).toEqual({ startUs: 0, endUs: 1000 });
  });

  it("redundant setZoom does not notify subscribers", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 0, endUs: 1000 });
    const cb = vi.fn();
    e.subscribe(cb);
    e.setZoom({ startUs: 0, endUs: 1000 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("degenerate ranges collapse to null and don't stack up when already null", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 200, endUs: 200 });   // zero width -> null == current
    e.setZoom({ startUs: 500, endUs: 100 });   // negative width -> null
    expect(e.zoomStackDepth()).toBe(0);
    expect(e.get().zoomRange).toBeNull();
  });

  it("stack is capped, evicting the oldest entry", () => {
    const e = new ViewStateEmitter();
    for (let i = 1; i <= 100; i++) e.setZoom({ startUs: 0, endUs: i });
    expect(e.zoomStackDepth()).toBe(32);
    // Walk the whole history back; the oldest entries (incl. the initial null)
    // were evicted, so we bottom out on a real range, not the full view.
    let popped = 0;
    while (e.popZoom()) popped++;
    expect(popped).toBe(32);
    expect(e.get().zoomRange).toEqual({ startUs: 0, endUs: 68 });
  });

  it("zoom history survives datum mutations", () => {
    const e = new ViewStateEmitter();
    e.setZoom({ startUs: 0, endUs: 1000 });
    e.addDatum(42);
    e.setZoom({ startUs: 10, endUs: 20 });
    e.popZoom();
    expect(e.get()).toEqual({ datums: [42], zoomRange: { startUs: 0, endUs: 1000 } });
  });
});
