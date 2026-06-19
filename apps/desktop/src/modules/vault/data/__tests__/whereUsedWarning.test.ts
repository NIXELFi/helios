import { describe, it, expect } from "vitest";
import { whereUsedWarning } from "../whereUsedWarning";
import type { WhereUsedRow } from "../useReferences";

describe("whereUsedWarning", () => {
  it("returns null when there are no parent assemblies (no warning needed)", () => {
    const result = whereUsedWarning([]);
    expect(result).toBeNull();
  });

  it("warns for a single parent assembly", () => {
    const parents: WhereUsedRow[] = [
      { parentFileId: "f1", parentVersionId: "v1", parentName: "TopLevel.SLDASM" },
    ];
    const result = whereUsedWarning(parents);
    expect(result).not.toBeNull();
    expect(result!.shouldWarn).toBe(true);
    expect(result!.message).toContain("1 assembly");
    expect(result!.message).toContain("TopLevel.SLDASM");
  });

  it("warns for multiple parent assemblies listing all names", () => {
    const parents: WhereUsedRow[] = [
      { parentFileId: "f1", parentVersionId: "v1", parentName: "Aero.SLDASM" },
      { parentFileId: "f2", parentVersionId: "v2", parentName: "Chassis.SLDASM" },
      { parentFileId: "f3", parentVersionId: "v3", parentName: "Frame.SLDASM" },
    ];
    const result = whereUsedWarning(parents);
    expect(result).not.toBeNull();
    expect(result!.shouldWarn).toBe(true);
    expect(result!.message).toContain("3 assemblies");
    expect(result!.message).toContain("Aero.SLDASM");
    expect(result!.message).toContain("Chassis.SLDASM");
    expect(result!.message).toContain("Frame.SLDASM");
  });

  it("uses 'assembly' (singular) for exactly 1 parent", () => {
    const parents: WhereUsedRow[] = [
      { parentFileId: "f1", parentVersionId: "v1", parentName: "Top.SLDASM" },
    ];
    const result = whereUsedWarning(parents);
    // must be "1 assembly", NOT "1 assemblies"
    expect(result!.message).toMatch(/\b1 assembly\b/);
  });

  it("uses 'assemblies' (plural) for 2+ parents", () => {
    const parents: WhereUsedRow[] = [
      { parentFileId: "f1", parentVersionId: "v1", parentName: "A.SLDASM" },
      { parentFileId: "f2", parentVersionId: "v2", parentName: "B.SLDASM" },
    ];
    const result = whereUsedWarning(parents);
    expect(result!.message).toMatch(/\b2 assemblies\b/);
  });
});
