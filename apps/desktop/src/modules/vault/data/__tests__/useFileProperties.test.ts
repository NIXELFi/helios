import { describe, it, expect } from "vitest";
import { propertiesDepKey } from "../useFileProperties";
import type { SwProperty } from "../types";

function prop(name: string, value: string): SwProperty {
  return { name, value };
}

describe("propertiesDepKey", () => {
  it("returns empty string for null", () => {
    expect(propertiesDepKey(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(propertiesDepKey(undefined)).toBe("");
  });

  it("returns empty string for an empty array", () => {
    expect(propertiesDepKey([])).toBe("");
  });

  it("produces the SAME key for identical prop arrays (same reference stability)", () => {
    const a = [prop("Material", "Steel"), prop("Finish", "Painted")];
    const b = [prop("Material", "Steel"), prop("Finish", "Painted")];
    expect(propertiesDepKey(a)).toBe(propertiesDepKey(b));
  });

  it("produces a DIFFERENT key when a VALUE changes with the same array length (the bug)", () => {
    // This is the exact scenario that the old `properties.length` key missed:
    // length is 2 in both cases, but one value changed.
    const before = [prop("Material", "Steel"), prop("Finish", "Painted")];
    const after  = [prop("Material", "Aluminum"), prop("Finish", "Painted")];
    expect(propertiesDepKey(before)).not.toBe(propertiesDepKey(after));
  });

  it("produces a DIFFERENT key when length changes", () => {
    const shorter = [prop("Material", "Steel")];
    const longer  = [prop("Material", "Steel"), prop("Finish", "Painted")];
    expect(propertiesDepKey(shorter)).not.toBe(propertiesDepKey(longer));
  });

  it("produces a DIFFERENT key when a NAME changes (same length, same values)", () => {
    const a = [prop("Material", "Steel")];
    const b = [prop("Matl", "Steel")];
    expect(propertiesDepKey(a)).not.toBe(propertiesDepKey(b));
  });

  it("order matters — different order gives different key (consistent with dep semantics)", () => {
    const a = [prop("A", "1"), prop("B", "2")];
    const b = [prop("B", "2"), prop("A", "1")];
    expect(propertiesDepKey(a)).not.toBe(propertiesDepKey(b));
  });
});
