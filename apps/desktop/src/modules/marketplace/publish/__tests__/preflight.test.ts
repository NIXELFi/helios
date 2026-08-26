import { describe, expect, it } from "vitest";
import { preflight, reportsDisagree } from "../preflight";

const manifest = {
  format: 1,
  id: "aero.test",
  name: "Test",
  version: "1.0.0",
  entry: "dist/index.html",
  sdk: "^1.0.0",
  permissions: [] as string[],
};

const cleanBundle = {
  "dist/index.html": "<!doctype html><body></body>",
  "dist/app.js": "const x = 1 + 1; document.body.textContent = String(x);",
};

describe("preflight", () => {
  it("passes a clean, pure-sandbox bundle", () => {
    const r = preflight(cleanBundle, manifest);

    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("blocks on a network call and names the file", () => {
    const r = preflight({ ...cleanBundle, "dist/app.js": "fetch('/data')" }, manifest);

    expect(r.ok).toBe(false);
    const finding = r.errors.find((e) => e.code === "forbidden-api");
    expect(finding?.path).toBe("dist/app.js");
    expect(finding?.helpTopic).toBe("network");
    expect(finding?.detail).toMatch(/no network access/i);
  });

  it("routes a browser-storage finding to the storage help topic", () => {
    const r = preflight({ ...cleanBundle, "dist/app.js": "localStorage.setItem('a','b')" }, manifest);

    const finding = r.errors.find((e) => e.code === "forbidden-api");
    expect(finding?.helpTopic).toBe("storage");
    expect(finding?.detail).toMatch(/SDK storage API/i);
  });

  it("routes an eval finding to the dynamic-code topic", () => {
    const r = preflight({ ...cleanBundle, "dist/app.js": "eval('1+1')" }, manifest);

    expect(r.errors.some((e) => e.helpTopic === "eval")).toBe(true);
  });

  it("blocks when code uses a capability the manifest does not declare", () => {
    const r = preflight(
      { ...cleanBundle, "dist/app.js": "storage.set('k', 1)" },
      { ...manifest, permissions: [] },
    );

    expect(r.ok).toBe(false);
    const finding = r.errors.find((e) => e.code === "undeclared-permission");
    expect(finding?.title).toMatch(/storage/);
    expect(finding?.helpTopic).toBe("permissions");
  });

  it("warns, but does not block, on a declared-but-unused permission", () => {
    const r = preflight(cleanBundle, { ...manifest, permissions: ["storage"] });

    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "unused-permission")).toBe(true);
  });

  it("reports manifest violations as blocking errors", () => {
    const r = preflight(cleanBundle, { ...manifest, version: "not-semver" });

    expect(r.ok).toBe(false);
    const finding = r.errors.find((e) => e.code === "manifest");
    expect(finding?.path).toBe("manifest.json");
    expect(finding?.detail).toMatch(/semver/i);
  });

  it("lists what passed, not only what failed", () => {
    const r = preflight(cleanBundle, manifest);

    const codes = r.passed.map((p) => p.code);
    expect(codes).toContain("manifest-valid");
    expect(codes).toContain("no-network");
    expect(codes).toContain("no-browser-storage");
    expect(codes).toContain("permissions-match");
  });

  it("drops a passing check once its area has a finding", () => {
    const r = preflight({ ...cleanBundle, "dist/app.js": "fetch('/x')" }, manifest);

    expect(r.passed.map((p) => p.code)).not.toContain("no-network");
    // Unrelated areas are still reported as passing.
    expect(r.passed.map((p) => p.code)).toContain("no-browser-storage");
  });

  it("gives every finding a help topic to link to", () => {
    const r = preflight(
      { ...cleanBundle, "dist/app.js": "fetch('/x'); localStorage.getItem('a');" },
      { ...manifest, version: "nope", permissions: ["file.read"] },
    );

    for (const f of [...r.errors, ...r.warnings]) {
      expect(f.helpTopic, `${f.code} has no help topic`).toBeTruthy();
      expect(f.detail.length, `${f.code} has no explanation`).toBeGreaterThan(0);
    }
  });

  it("produces a JSON-serializable raw report for review_report", () => {
    const r = preflight(cleanBundle, manifest);

    expect(() => JSON.stringify(r.raw)).not.toThrow();
    expect(r.raw.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("reportsDisagree", () => {
  it("is false when the stored report matches a fresh scan", () => {
    const fresh = preflight(cleanBundle, manifest);

    expect(reportsDisagree(fresh.raw, fresh)).toBe(false);
  });

  it("is true when the fresh scan found something the stored report did not", () => {
    const stored = preflight(cleanBundle, manifest);
    const fresh = preflight({ ...cleanBundle, "dist/app.js": "fetch('/x')" }, manifest);

    expect(reportsDisagree(stored.raw, fresh)).toBe(true);
  });

  it("is false when there is no stored report to compare against", () => {
    const fresh = preflight(cleanBundle, manifest);

    expect(reportsDisagree(null, fresh)).toBe(false);
  });
});
