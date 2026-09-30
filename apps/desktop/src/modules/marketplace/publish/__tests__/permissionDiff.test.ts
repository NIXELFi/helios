import { describe, expect, it } from "vitest";
import { describeDiff, permissionDiff } from "../permissionDiff";

describe("permissionDiff", () => {
  it("marks newly requested permissions as added", () => {
    const d = permissionDiff(["storage"], ["storage", "file.write"]);

    expect(d.added).toEqual(["file.write"]);
    expect(d.unchanged).toEqual(["storage"]);
    expect(d.removed).toEqual([]);
    expect(d.identical).toBe(false);
  });

  it("marks dropped permissions as removed", () => {
    const d = permissionDiff(["storage", "file.read"], ["storage"]);

    expect(d.removed).toEqual(["file.read"]);
    expect(d.added).toEqual([]);
  });

  it("treats a first version as all-added", () => {
    const d = permissionDiff(null, ["storage"]);

    expect(d.isFirstVersion).toBe(true);
    expect(d.added).toEqual(["storage"]);
  });

  it("says nothing changed when nothing changed", () => {
    const d = permissionDiff(["storage", "file.read"], ["file.read", "storage"]);

    expect(d.identical).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("flags a newly added high-trust permission", () => {
    const d = permissionDiff(["storage"], ["storage", "engine:matlab"]);

    expect(d.addsHighTrust).toBe(true);
  });

  it("does not flag high trust when the high-trust permission was already approved", () => {
    const d = permissionDiff(["engine:matlab"], ["engine:matlab", "storage"]);

    expect(d.added).toEqual(["storage"]);
    expect(d.addsHighTrust).toBe(false);
  });

  it("deduplicates a manifest that lists the same permission twice", () => {
    const d = permissionDiff(null, ["storage", "storage"]);

    expect(d.added).toEqual(["storage"]);
  });
});

describe("describeDiff", () => {
  it("reads reassuringly when nothing changed", () => {
    expect(describeDiff(permissionDiff(["storage"], ["storage"]))).toMatch(/no change/i);
  });

  it("calls out a pure-sandbox first release", () => {
    expect(describeDiff(permissionDiff(null, []))).toMatch(/pure sandbox/i);
  });

  it("counts what a changed version asks for", () => {
    expect(describeDiff(permissionDiff(["storage"], ["file.write"]))).toMatch(
      /asks for 1 new, drops 1/i,
    );
  });
});
