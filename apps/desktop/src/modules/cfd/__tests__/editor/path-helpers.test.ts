import { describe, it, expect } from "vitest";
import { getAt, setAt, deleteAt } from "../../editor/lib/path-helpers";
import { deepEqual } from "../../editor/lib/deep-equal";

describe("path-helpers", () => {
  describe("getAt", () => {
    it("reads nested scalars", () => {
      expect(getAt({ a: { b: 1 } }, "a.b")).toBe(1);
    });
    it("returns undefined for missing keys", () => {
      expect(getAt({ a: { b: 1 } }, "a.c")).toBeUndefined();
      expect(getAt({}, "a.b.c")).toBeUndefined();
    });
    it("returns the input when path is empty", () => {
      const o = { a: 1 };
      expect(getAt(o, "")).toBe(o);
    });
    it("reads array elements via numeric path segment", () => {
      expect(getAt({ pipes: [{ x: 5 }, { x: 6 }] }, "pipes.0.x")).toBe(5);
      expect(getAt({ pipes: [{ x: 5 }, { x: 6 }] }, "pipes.1.x")).toBe(6);
    });
  });

  describe("setAt", () => {
    it("returns a new object without mutating the original", () => {
      const o = { a: { b: 1 }, c: 2 };
      const r = setAt(o, "a.b", 99);
      expect(r).toEqual({ a: { b: 99 }, c: 2 });
      expect(o.a.b).toBe(1);
      expect(r).not.toBe(o);
      expect(r.a).not.toBe(o.a);
    });
    it("creates intermediate objects on missing paths", () => {
      expect(setAt({}, "a.b.c", 5)).toEqual({ a: { b: { c: 5 } } });
    });
    it("preserves array shape on numeric segments", () => {
      const o = { items: [{ x: 1 }, { x: 2 }] };
      const r = setAt(o, "items.0.x", 99);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((r as any).items[0].x).toBe(99);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((r as any).items[1].x).toBe(2);
      expect(o.items[0]!.x).toBe(1);
    });
  });

  describe("deleteAt", () => {
    it("removes a top-level key without mutating", () => {
      const o = { a: 1, b: 2 };
      const r = deleteAt(o, "a");
      expect(r).toEqual({ b: 2 });
      expect(o).toEqual({ a: 1, b: 2 });
    });
    it("removes a nested key", () => {
      const o = { a: { b: 1, c: 2 } };
      const r = deleteAt(o, "a.b");
      expect(r).toEqual({ a: { c: 2 } });
    });
    it("returns the input unchanged when the path doesn't resolve", () => {
      const o = { a: { b: 1 } };
      const r = deleteAt(o, "x.y");
      expect(r).toBe(o);
    });
  });
});

describe("deepEqual", () => {
  it("handles primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });
  it("handles arrays", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });
  it("handles nested objects", () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  });
  it("returns false when key sets differ", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
});
