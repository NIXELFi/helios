import { describe, it, expect } from "vitest";
import { resolveDropFolder } from "../drop-target";

/**
 * Minimal fake element graph: each node exposes `getAttribute` (reading from a
 * supplied attribute map) and `parentElement` (the next node up the chain),
 * matching the slice of the DOM `Element` API resolveDropFolder relies on.
 */
function node(
  attrs: Record<string, string>,
  parent: FakeEl | null = null,
): FakeEl {
  return {
    getAttribute: (name: string) =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null,
    parentElement: parent,
  };
}

interface FakeEl {
  getAttribute: (name: string) => string | null;
  parentElement: FakeEl | null;
}

function at(el: FakeEl | null) {
  return () => el as unknown as Element | null;
}

describe("resolveDropFolder", () => {
  it("returns the folder id when the hit element itself is tagged", () => {
    const el = node({ "data-folder-id": "folder-1" });
    expect(resolveDropFolder(10, 20, "fallback", at(el))).toBe("folder-1");
  });

  it("walks up to a tagged ancestor when the hit element is an inner child", () => {
    const root = node({ "data-folder-id": "folder-2" });
    const middle = node({}, root);
    const leaf = node({}, middle); // e.g. an inner <span> with no attribute
    expect(resolveDropFolder(0, 0, "fallback", at(leaf))).toBe("folder-2");
  });

  it("resolves an empty data-folder-id to null (vault root)", () => {
    const leaf = node({}, node({ "data-folder-id": "" }));
    expect(resolveDropFolder(0, 0, "fallback", at(leaf))).toBeNull();
  });

  it("distinguishes vault-root (empty attr) from nothing-tagged (fallback)", () => {
    // Nothing in the chain carries the attribute → fallback, NOT null.
    const leaf = node({}, node({}, node({})));
    expect(resolveDropFolder(0, 0, "fallback", at(leaf))).toBe("fallback");
  });

  it("returns the fallback (which may be null) when nothing is tagged", () => {
    const leaf = node({});
    expect(resolveDropFolder(0, 0, null, at(leaf))).toBeNull();
  });

  it("returns the fallback when the hit point maps to no element at all", () => {
    expect(resolveDropFolder(0, 0, "fallback", at(null))).toBe("fallback");
  });

  it("stops at the FIRST tagged ancestor (nearest wins)", () => {
    const outer = node({ "data-folder-id": "outer" });
    const inner = node({ "data-folder-id": "inner" }, outer);
    const leaf = node({}, inner);
    expect(resolveDropFolder(0, 0, "fallback", at(leaf))).toBe("inner");
  });
});
