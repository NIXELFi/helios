import { describe, it, expect } from "vitest";
import {
  validateManifest,
  isSdkCompatible,
  SDK_CONTRACT_VERSION,
  type PluginManifest,
} from "../src/manifest";

function base(): PluginManifest {
  return {
    format: 1,
    id: "aero.downforce-calculator",
    name: "Downforce Calculator",
    version: "1.4.0",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions: [],
  };
}

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const r = validateManifest(base());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts known permissions", () => {
    const r = validateManifest({ ...base(), permissions: ["file.read", "storage"] });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("nope").ok).toBe(false);
  });

  it("rejects an unsupported format", () => {
    const r = validateManifest({ ...base(), format: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/format/);
  });

  it("rejects a bad id", () => {
    const r = validateManifest({ ...base(), id: "Aero Downforce!" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/id/);
  });

  it("rejects a non-semver version", () => {
    const r = validateManifest({ ...base(), version: "v1" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/version/);
  });

  it("rejects an unknown permission (default-deny catalog)", () => {
    const r = validateManifest({ ...base(), permissions: ["fs.readAll"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown permission/);
  });

  it("rejects a missing entry", () => {
    const m = base();
    // @ts-expect-error intentionally drop a required field
    delete m.entry;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/entry/);
  });
});

describe("isSdkCompatible", () => {
  it("accepts a caret range on the same major", () => {
    expect(isSdkCompatible("^1.0.0", SDK_CONTRACT_VERSION)).toBe(true);
    expect(isSdkCompatible("^1.2.0", "1.5.0")).toBe(true);
  });

  it("rejects a different major", () => {
    expect(isSdkCompatible("^2.0.0", "1.0.0")).toBe(false);
    expect(isSdkCompatible("^1.0.0", "2.0.0")).toBe(false);
  });

  it("handles exact versions", () => {
    expect(isSdkCompatible("1.0.0", "1.0.0")).toBe(true);
    expect(isSdkCompatible("1.0.1", "1.0.0")).toBe(false);
  });

  it("rejects garbage ranges", () => {
    expect(isSdkCompatible("banana", "1.0.0")).toBe(false);
  });
});
