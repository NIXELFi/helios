import { describe, expect, it } from "vitest";
import { formatFileOpenSummary, type PerFileResult } from "../src/lib/file-open-summary";
import type { Workspace } from "../src/workspaces/types";

function ws(label: string): Workspace {
  return { id: label, label, color: "#FFC627", tiles: [] };
}
function valid(filename: string, labels: string[]): PerFileResult {
  return { filename, kind: "valid", workspaces: labels.map(ws) };
}
function invalid(filename: string, reason: string): PerFileResult {
  return { filename, kind: "invalid", reason };
}

describe("formatFileOpenSummary", () => {
  it("1 file, 1 workspace", () => {
    const s = formatFileOpenSummary([valid("driver.helios", ["Driver"])]);
    expect(s.isAlert).toBe(false);
    expect(s.title).toBe("Import workspace from driver.helios?");
    expect(s.body).toBe(`"Driver"`);
  });

  it("1 file, N workspaces (N <= 8)", () => {
    const s = formatFileOpenSummary([valid("all.helios", ["A", "B", "C"])]);
    expect(s.title).toBe("Import 3 workspaces from all.helios?");
    expect(s.body).toBe(`"A", "B", "C"`);
  });

  it("1 file, 9 workspaces — body truncates with overflow count", () => {
    const labels = Array.from({ length: 9 }, (_, i) => `W${i + 1}`);
    const s = formatFileOpenSummary([valid("big.helios", labels)]);
    expect(s.title).toBe("Import 9 workspaces from big.helios?");
    expect(s.body).toBe(`"W1", "W2", and 7 more`);
  });

  it("K files (K <= 6), M workspaces", () => {
    const s = formatFileOpenSummary([
      valid("a.helios", ["A"]),
      valid("b.helios", ["B", "C"]),
    ]);
    expect(s.title).toBe("Import 3 workspaces from 2 files?");
    expect(s.body).toBe("a.helios · b.helios");
  });

  it("K files (K > 6), M workspaces — body truncates", () => {
    const files = Array.from({ length: 8 }, (_, i) => valid(`f${i}.helios`, ["x"]));
    const s = formatFileOpenSummary(files);
    expect(s.title).toBe("Import 8 workspaces from 8 files?");
    expect(s.body).toBe("f0.helios · f1.helios · and 6 more");
  });

  it("some files invalid — appends a skipped line", () => {
    const s = formatFileOpenSummary([
      valid("a.helios", ["A"]),
      invalid("bad.helios", "Not a Helios workspace file."),
    ]);
    expect(s.isAlert).toBe(false);
    expect(s.title).toBe("Import workspace from a.helios?");
    expect(s.body).toMatch(/^"A"\n\(1 file\(s\) skipped — not valid Helios bundles\)$/);
  });

  it("all files invalid — alert mode", () => {
    const s = formatFileOpenSummary([
      invalid("bad1.helios", "Not a Helios workspace file."),
      invalid("bad2.helios", "Bundle contains no workspaces."),
    ]);
    expect(s.isAlert).toBe(true);
    expect(s.title).toBe("Could not open");
    expect(s.body).toBe(`"bad1.helios": Not a Helios workspace file.\n"bad2.helios": Bundle contains no workspaces.`);
  });
});
