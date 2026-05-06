import { describe, expect, it } from "vitest";
import { slugifyForFilename, serializeBundle, BUNDLE_KIND, BUNDLE_VERSION } from "../src/lib/workspace-bundle";
import type { Workspace } from "../src/workspaces/types";

const sampleWs: Workspace[] = [
  { id: "a", label: "A", color: "#FFC627", tiles: [] },
];

describe("slugifyForFilename", () => {
  it("lowercases and dashes spaces", () => {
    expect(slugifyForFilename("Driver Tryout")).toBe("driver-tryout");
  });
  it("collapses runs of non-alphanumerics", () => {
    expect(slugifyForFilename("SDM26  ---  best!!  accel")).toBe("sdm26-best-accel");
  });
  it("trims leading/trailing dashes", () => {
    expect(slugifyForFilename("  --hello--  ")).toBe("hello");
  });
  it("falls back to 'workspace' for empty/all-symbol input", () => {
    expect(slugifyForFilename("")).toBe("workspace");
    expect(slugifyForFilename("///---")).toBe("workspace");
  });
});

describe("serializeBundle", () => {
  it("produces a JSON string with the documented shape", () => {
    const json = serializeBundle(sampleWs, "1.2.3");
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe(BUNDLE_KIND);
    expect(parsed.version).toBe(BUNDLE_VERSION);
    expect(parsed.exportedFrom).toBe("Helios 1.2.3");
    expect(typeof parsed.exportedAt).toBe("string");
    expect(new Date(parsed.exportedAt).toString()).not.toBe("Invalid Date");
    expect(parsed.workspaces).toEqual(sampleWs);
  });

  it("does not mutate input workspaces", () => {
    const before = JSON.parse(JSON.stringify(sampleWs));
    serializeBundle(sampleWs, "x");
    expect(sampleWs).toEqual(before);
  });
});
