import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  ALL_PERMISSIONS,
  TIER0_METHODS,
  isKnownMethod,
  permissionForMethod,
  tierForMethod,
} from "../src/capabilities";

describe("capability catalog", () => {
  it("lists every permission in ALL_PERMISSIONS", () => {
    expect(new Set(ALL_PERMISSIONS)).toEqual(new Set(Object.keys(CAPABILITIES)));
  });

  it("recognises Tier 0 methods without a permission", () => {
    for (const m of TIER0_METHODS) {
      expect(isKnownMethod(m)).toBe(true);
      expect(permissionForMethod(m)).toBeNull();
      expect(tierForMethod(m)).toBe(0);
    }
  });

  it("maps each capability method to its permission and tier", () => {
    expect(permissionForMethod("file.read")).toBe("file.read");
    expect(permissionForMethod("storage.set")).toBe("storage");
    expect(permissionForMethod("engine.matlab.run")).toBe("engine:matlab");
    expect(tierForMethod("engine.matlab.run")).toBe(2);
    expect(tierForMethod("storage.set")).toBe(1);
  });

  it("treats unknown methods as not known", () => {
    expect(isKnownMethod("fs.readAll")).toBe(false);
    expect(isKnownMethod("engine.python.run")).toBe(false);
  });
});
