import { describe, expect, it } from "vitest";
import { versionBadge } from "../version-badge";

describe("versionBadge", () => {
  it("shows the latest version number (dim) when synced", () => {
    const badge = versionBadge("synced", 14, undefined);
    expect(badge).toEqual({ text: "v14", tone: "dim" });
  });

  it("shows nothing for a vault-only (not local) file", () => {
    expect(versionBadge("vault-only", 14, undefined)).toBeNull();
  });

  it("shows nothing for a no-folder row", () => {
    expect(versionBadge("no-folder", 14, undefined)).toBeNull();
  });

  it("names the local revision when modified and the local sha matches an older version", () => {
    const badge = versionBadge("modified", 14, 12);
    expect(badge).toEqual({
      text: "v12 of v14",
      tone: "warn",
      title: "Your local copy is v12; latest is v14",
    });
  });

  it("falls back to 'edited' when modified and the local sha matches no known version", () => {
    const badge = versionBadge("modified", 14, undefined);
    expect(badge).toEqual({
      text: "edited",
      tone: "warn",
      title: "Local copy differs from every vault version",
    });
  });

  it("shows nothing when synced but there is no latest version number", () => {
    expect(versionBadge("synced", undefined, undefined)).toBeNull();
  });
});
