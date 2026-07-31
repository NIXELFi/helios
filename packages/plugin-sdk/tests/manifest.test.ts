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

  it("rejects an entry that escapes the bundle (traversal / absolute / scheme)", () => {
    for (const entry of ["../../secret.html", "/etc/passwd", "C:\\evil.html", "http://evil/x.html"]) {
      const r = validateManifest({ ...base(), entry });
      expect(r.ok, entry).toBe(false);
      expect(r.errors.join(" ")).toMatch(/entry/);
    }
  });

  it("rejects a PERCENT-ENCODED traversal in entry", () => {
    // The literal-".." test alone missed these: `entry` is concatenated into a URL
    // and the WHATWG parser decodes %2e/%2f back into real path segments, so an
    // encoded escape would have mounted another installed plugin's bundle.
    for (const entry of [
      "%2e%2e/%2e%2e/other.plugin/dist/index.html",
      "%2E%2E/x.html",
      "dist%2f..%2findex.html",
      "dist%5c..%5cindex.html",
    ]) {
      const r = validateManifest({ ...base(), entry });
      expect(r.ok, entry).toBe(false);
      expect(r.errors.join(" ")).toMatch(/entry/);
    }
  });

  it("still accepts a plain relative entry", () => {
    for (const entry of ["dist/index.html", "index.html", "ui/app.v2.html"]) {
      const r = validateManifest({ ...base(), entry });
      expect(r.ok, entry).toBe(true);
    }
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

  it("rejects a host older than the requested minor/patch floor", () => {
    expect(isSdkCompatible("^1.5.0", "1.0.0")).toBe(false);
    expect(isSdkCompatible("^1.0.5", "1.0.0")).toBe(false);
    expect(isSdkCompatible("^1.0.0", "1.5.0")).toBe(true); // host newer within major is fine
    expect(isSdkCompatible("^1.2.0", "1.2.3")).toBe(true);
  });

  it("handles exact versions", () => {
    expect(isSdkCompatible("1.0.0", "1.0.0")).toBe(true);
    expect(isSdkCompatible("1.0.1", "1.0.0")).toBe(false);
  });

  it("rejects garbage ranges", () => {
    expect(isSdkCompatible("banana", "1.0.0")).toBe(false);
  });
});
