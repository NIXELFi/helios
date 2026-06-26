import { describe, it, expect } from "vitest";
import { scanBundle } from "../src/compliance.mjs";

const manifest = (permissions: string[]) => ({
  format: 1,
  id: "x.y",
  name: "X",
  version: "1.0.0",
  entry: "dist/index.html",
  sdk: "^1.0.0",
  permissions,
});

describe("scanBundle — forbidden APIs", () => {
  it("flags a global fetch( call", () => {
    const f = scanBundle({ "dist/index.html": "<script>fetch('/x')</script>" }, manifest([]));
    expect(f.some((x) => x.kind === "forbidden-api" && /fetch/.test(x.message))).toBe(true);
  });

  it("does NOT flag a member .fetch( call (A-review M6: global-vs-member)", () => {
    const f = scanBundle({ "dist/app.js": "const r = store.fetch(); obj.eval(1);" }, manifest([]));
    expect(f.filter((x) => x.kind === "forbidden-api")).toHaveLength(0);
  });

  it("flags cookies, alternate storage, and WebSocket", () => {
    const f = scanBundle(
      { "dist/app.js": "document.cookie; localStorage; new WebSocket('x')" },
      manifest([]),
    );
    const msgs = f.filter((x) => x.kind === "forbidden-api").map((x) => x.message).join("\n");
    expect(msgs).toMatch(/cookie/);
    expect(msgs).toMatch(/localStorage/);
    expect(msgs).toMatch(/WebSocket/);
  });

  it("ignores non-scannable files (e.g. .json, .png)", () => {
    const f = scanBundle({ "data.json": "{\"x\": \"fetch(\"}", "logo.png": "fetch(" }, manifest([]));
    expect(f.filter((x) => x.kind === "forbidden-api")).toHaveLength(0);
  });
});

describe("scanBundle — declared-vs-used", () => {
  it("errors when code uses an undeclared capability", () => {
    const f = scanBundle({ "dist/app.js": "storage.set('k', 1)" }, manifest([]));
    expect(
      f.some((x) => x.kind === "undeclared-permission" && x.permission === "storage"),
    ).toBe(true);
  });

  it("warns (not errors) when a declared permission is unused", () => {
    const f = scanBundle({ "dist/app.js": "console.log(1)" }, manifest(["storage"]));
    const unused = f.find((x) => x.kind === "unused-permission");
    expect(unused?.permission).toBe("storage");
    expect(unused?.level).toBe("warn");
  });

  it("a clean, matched bundle yields no errors", () => {
    const f = scanBundle({ "dist/app.js": "storage.get('k'); save(b, 'r.csv');" }, manifest(["storage", "file.write"]));
    expect(f.filter((x) => x.level === "error")).toHaveLength(0);
  });

  it("matches raw wire-method strings too (not just SDK helpers)", () => {
    const f = scanBundle({ "dist/app.js": "client.call('engine.matlab.run', {})" }, manifest([]));
    expect(
      f.some((x) => x.kind === "undeclared-permission" && x.permission === "engine:matlab"),
    ).toBe(true);
  });
});
