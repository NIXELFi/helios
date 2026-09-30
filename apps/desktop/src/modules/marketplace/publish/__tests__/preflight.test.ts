import { describe, expect, it } from "vitest";
import { manifestDrift, preflight } from "../preflight";

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

describe("manifestDrift", () => {
  it("is empty when the bundle carries the submitted manifest", () => {
    expect(manifestDrift(manifest, { ...manifest, permissions: [] })).toEqual([]);
  });

  it("ignores permission order", () => {
    const a = { ...manifest, permissions: ["storage", "file.read"] };
    const b = { ...manifest, permissions: ["file.read", "storage"] };
    expect(manifestDrift(a, b)).toEqual([]);
  });

  it("blocks on a different version or extra permissions inside the bundle", () => {
    const d = manifestDrift(manifest, { ...manifest, version: "9.9.9", permissions: ["engine:matlab"] });
    expect(d.map((f) => f.title)).toEqual([
      "The bundle's version does not match what was submitted",
      "The bundle's permissions does not match what was submitted",
    ]);
    expect(d.every((f) => f.level === "error" && f.code === "manifest-drift")).toBe(true);
  });
});

describe("preflight — external files the sandbox never loads", () => {
  it("blocks a multi-file build with an explanation that names the fix", () => {
    const r = preflight(
      { "dist/index.html": '<script type="module" src="./assets/index.js"></script>' },
      manifest,
    );
    expect(r.ok).toBe(false);
    const f = r.errors.find((e) => e.code === "external-asset");
    expect(f?.title).toMatch(/loads code from a separate file/i);
    expect(f?.detail).toMatch(/single-file/i);
    expect(f?.helpTopic).toBe("bundle");
  });

  it("only warns about a missing image", () => {
    const r = preflight({ "dist/index.html": '<img src="logo.png">' }, manifest);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "external-asset")).toBe(true);
  });
});

describe("preflight — files too large to scan", () => {
  it("blocks when the entry page itself was not scanned, and claims nothing passed", () => {
    const r = preflight({ "dist/app.js": "1" }, manifest, ["dist/index.html"]);
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.code === "unscanned")?.title).toMatch(/entry page is too large/i);
    expect(r.passed.some((p) => p.code === "no-network")).toBe(false);
  });

  it("only warns about another unscanned file", () => {
    const r = preflight(cleanBundle, manifest, ["dist/vendor.js"]);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "unscanned" && w.path === "dist/vendor.js")).toBe(true);
    expect(r.passed.some((p) => p.code === "no-network")).toBe(false);
  });
});
