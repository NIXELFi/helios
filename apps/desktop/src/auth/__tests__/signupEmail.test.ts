import { describe, expect, it } from "vitest";

import { signupErrorMessage, validateSignupEmail } from "../signupEmail";

describe("validateSignupEmail", () => {
  it("rejects malformed addresses", () => {
    expect(validateSignupEmail("nope", ["asu.edu"])).toBe("Enter a valid email address.");
  });

  it("rejects a domain outside the allowlist inline", () => {
    expect(validateSignupEmail("someone@gmail.com", ["asu.edu"])).toBe(
      "Sign-up is restricted to @asu.edu accounts.",
    );
  });

  it("accepts an allowed domain case-insensitively", () => {
    expect(validateSignupEmail("  Sparky@ASU.edu ", ["asu.edu"])).toBeNull();
  });

  it("skips the domain check when the list is unknown or empty", () => {
    expect(validateSignupEmail("someone@gmail.com", null)).toBeNull();
    expect(validateSignupEmail("someone@gmail.com", [])).toBeNull();
  });
});

describe("signupErrorMessage", () => {
  const gotrue500 = { message: "Database error saving new user", status: 500 };

  it("turns GoTrue's opaque trigger 500 into the domain message", () => {
    expect(signupErrorMessage(gotrue500, ["asu.edu"])).toBe(
      "Sign-up is restricted to @asu.edu accounts.",
    );
  });

  it("still explains the rejection when the allowlist never loaded", () => {
    expect(signupErrorMessage(gotrue500, null)).toBe(
      "Sign-up was rejected. Use your organization email address.",
    );
  });

  it("passes other errors through untouched", () => {
    expect(signupErrorMessage({ message: "User already registered" }, ["asu.edu"])).toBe(
      "User already registered",
    );
  });
});
