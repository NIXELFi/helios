import { describe, expect, it } from "vitest";
import { slugifyForFilename } from "../src/lib/workspace-bundle";

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
