import { describe, it, expect } from "vitest";
import { isNewer, hasUpdate } from "../lib/version";

describe("isNewer", () => {
  it("compares core versions numerically (not lexically)", () => {
    expect(isNewer("1.10.0", "1.9.0")).toBe(true); // 10 > 9 even though "10" < "9" as text
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
  });

  it("is false for equal or older versions", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
    expect(isNewer("1.9.0", "1.10.0")).toBe(false);
  });

  it("ranks a pre-release below the matching release", () => {
    expect(isNewer("1.2.0", "1.2.0-rc.1")).toBe(true);
    expect(isNewer("1.2.0-rc.1", "1.2.0")).toBe(false);
  });
});

describe("hasUpdate", () => {
  it("is false when not installed", () => {
    expect(hasUpdate({ version: "2.0.0", installedVersion: null })).toBe(false);
  });
  it("is true only when the approved version is ahead of the installed one", () => {
    expect(hasUpdate({ version: "2.0.0", installedVersion: "1.0.0" })).toBe(true);
    expect(hasUpdate({ version: "1.0.0", installedVersion: "1.0.0" })).toBe(false);
  });
});
