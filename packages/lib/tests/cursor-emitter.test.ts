import { describe, it, expect, vi } from "vitest";
import { CursorEmitter } from "../src/cursor-emitter";

describe("CursorEmitter", () => {
  it("delivers updates to subscribers", () => {
    const e = new CursorEmitter();
    const cb = vi.fn();
    e.subscribe(cb);
    e.emit(1234);
    expect(cb).toHaveBeenCalledWith(1234);
  });

  it("unsubscribe stops delivery", () => {
    const e = new CursorEmitter();
    const cb = vi.fn();
    const off = e.subscribe(cb);
    off();
    e.emit(99);
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple subscribers each receive emissions", () => {
    const e = new CursorEmitter();
    const a = vi.fn(); const b = vi.fn();
    e.subscribe(a); e.subscribe(b);
    e.emit(7);
    expect(a).toHaveBeenCalledWith(7);
    expect(b).toHaveBeenCalledWith(7);
  });

  it("get() returns last emitted value", () => {
    const e = new CursorEmitter();
    e.emit(42);
    expect(e.get()).toBe(42);
  });

  it("a subscriber unsubscribing during emit still delivers to the rest", () => {
    // Listeners are snapshotted before iterating, so mutating the set inside a
    // callback doesn't skip a later subscriber.
    const e = new CursorEmitter();
    const a = vi.fn();
    let offA: () => void = () => {};
    const b = vi.fn(() => offA());
    const c = vi.fn();
    e.subscribe(a);
    offA = e.subscribe(b);
    e.subscribe(c);
    e.emit(5);
    expect(a).toHaveBeenCalledWith(5);
    expect(b).toHaveBeenCalledWith(5);
    expect(c).toHaveBeenCalledWith(5);
  });
});
