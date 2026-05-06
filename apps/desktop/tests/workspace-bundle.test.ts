import { describe, expect, it } from "vitest";
import { slugifyForFilename, serializeBundle, parseBundle, mergeImported, BUNDLE_KIND, BUNDLE_VERSION } from "../src/lib/workspace-bundle";
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

describe("parseBundle", () => {
  const validBundle = JSON.stringify({
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: "2026-05-06T00:00:00.000Z",
    exportedFrom: "Helios 2.3.2",
    workspaces: [{ id: "a", label: "A", color: "#FFC627", tiles: [] }],
  });

  it("accepts a well-formed bundle", () => {
    const r = parseBundle(validBundle);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundle.workspaces.length).toBe(1);
  });

  it("rejects non-JSON", () => {
    const r = parseBundle("not json {");
    expect(r.ok).toBe(false);
  });

  it("rejects wrong kind", () => {
    const r = parseBundle(JSON.stringify({ ...JSON.parse(validBundle), kind: "other" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a Helios workspace file/i);
  });

  it("rejects wrong version", () => {
    const r = parseBundle(JSON.stringify({ ...JSON.parse(validBundle), version: 99 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/version/i);
  });

  it("rejects missing workspaces array", () => {
    const r = parseBundle(JSON.stringify({ kind: BUNDLE_KIND, version: 1 }));
    expect(r.ok).toBe(false);
  });

  it("rejects empty workspaces array", () => {
    const r = parseBundle(JSON.stringify({ ...JSON.parse(validBundle), workspaces: [] }));
    expect(r.ok).toBe(false);
  });

  it("rejects workspace missing required fields", () => {
    const r = parseBundle(JSON.stringify({
      ...JSON.parse(validBundle),
      workspaces: [{ id: "a", label: "A" }],  // no color, no tiles
    }));
    expect(r.ok).toBe(false);
  });
});

describe("mergeImported", () => {
  const existing: Workspace[] = [
    { id: "x", label: "Overview", color: "#FFC627", tiles: [] },
  ];

  it("regenerates ids on every imported workspace", () => {
    const imported: Workspace[] = [
      { id: "x", label: "Other", color: "#aaa", tiles: [] },
    ];
    const out = mergeImported(existing, imported);
    expect(out.length).toBe(2);
    expect(out[1]!.id).not.toBe("x");
    expect(out[0]!.id).toBe("x");  // existing untouched
  });

  it("appends ' (imported)' on label collision", () => {
    const imported: Workspace[] = [
      { id: "y", label: "Overview", color: "#aaa", tiles: [] },
    ];
    const out = mergeImported(existing, imported);
    expect(out[1]!.label).toBe("Overview (imported)");
  });

  it("chains '(imported 2)', '(imported 3)' on repeated collisions", () => {
    const e: Workspace[] = [
      { id: "x", label: "Overview", color: "#fff", tiles: [] },
      { id: "y", label: "Overview (imported)", color: "#fff", tiles: [] },
    ];
    const out = mergeImported(e, [
      { id: "z", label: "Overview", color: "#aaa", tiles: [] },
    ]);
    expect(out[2]!.label).toBe("Overview (imported 2)");
  });

  it("dedupes labels among multiple imports in one batch", () => {
    const out = mergeImported(existing, [
      { id: "a", label: "Overview", color: "#1", tiles: [] },
      { id: "b", label: "Overview", color: "#2", tiles: [] },
    ]);
    expect(out[1]!.label).toBe("Overview (imported)");
    expect(out[2]!.label).toBe("Overview (imported 2)");
  });

  it("does not mutate inputs", () => {
    const e = [{ id: "x", label: "X", color: "#1", tiles: [] }];
    const i = [{ id: "y", label: "X", color: "#2", tiles: [] }];
    const eBefore = JSON.parse(JSON.stringify(e));
    const iBefore = JSON.parse(JSON.stringify(i));
    mergeImported(e, i);
    expect(e).toEqual(eBefore);
    expect(i).toEqual(iBefore);
  });
});
