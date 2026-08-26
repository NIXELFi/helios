import { describe, expect, it } from "vitest";
import { explainPublishError, isDuplicateObjectError } from "../publishErrors";

describe("explainPublishError", () => {
  it("turns the immutable-version raise into a concrete bump instruction", () => {
    const e = explainPublishError(
      new Error("version 1.2.0 of aero.x already exists (versions are immutable)"),
      { version: "1.2.0" },
    );

    expect(e.title).toMatch(/1\.2\.0 has already been published/);
    expect(e.detail).toMatch(/bump "version" in manifest\.json to 1\.2\.1/i);
    expect(e.helpTopic).toBe("versions");
    expect(e.retryable).toBe(false);
  });

  it("explains an insufficient-privilege raise in terms of the capability", () => {
    const e = explainPublishError(
      new Error("insufficient privilege to publish a new plugin to subteam abc"),
    );

    expect(e.detail).toMatch(/marketplace\.publish/);
    expect(e.detail).toMatch(/ask your lead or vp/i);
    expect(e.retryable).toBe(false);
  });

  it("explains the size ceiling in terms of what to look for", () => {
    const e = explainPublishError(new Error("bundle_bytes out of range (1..25MiB): 40000000"));

    expect(e.title).toMatch(/too large/i);
    expect(e.helpTopic).toBe("bundle");
  });

  it("keeps the server's manifest complaint verbatim", () => {
    const e = explainPublishError(new Error("manifest.id is missing or invalid: <null>"));

    expect(e.detail).toMatch(/manifest\.id is missing or invalid/);
    expect(e.helpTopic).toBe("manifest");
  });

  it("marks a network failure retryable and says the bundle was kept", () => {
    const e = explainPublishError(new TypeError("Failed to fetch"));

    expect(e.retryable).toBe(true);
    expect(e.detail).toMatch(/retry will not have to rebuild/i);
  });

  it("treats an expired session as retryable after signing in", () => {
    const e = explainPublishError(new Error("authentication required"));

    expect(e.retryable).toBe(true);
    expect(e.detail).toMatch(/nothing was published/i);
  });

  it("falls back to the raw message rather than swallowing an unknown error", () => {
    const e = explainPublishError(new Error("some entirely novel failure"));

    expect(e.detail).toBe("some entirely novel failure");
  });

  it("handles a plain string and a non-error object", () => {
    expect(explainPublishError("boom").detail).toBe("boom");
    expect(explainPublishError({ message: "objly" }).detail).toBe("objly");
  });
});

describe("isDuplicateObjectError", () => {
  it("recognises the storage duplicate-object rejection", () => {
    expect(isDuplicateObjectError({ message: "The resource already exists" })).toBe(true);
    expect(isDuplicateObjectError({ message: "Duplicate", statusCode: "409" })).toBe(true);
  });

  it("does not swallow an unrelated upload failure", () => {
    expect(isDuplicateObjectError({ message: "Payload too large", statusCode: "413" })).toBe(false);
  });
});
