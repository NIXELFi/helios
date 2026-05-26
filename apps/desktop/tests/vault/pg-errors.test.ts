import { describe, it, expect } from "vitest";
import { friendlyPgError } from "../../src/modules/vault/data/pg-errors";

describe("friendlyPgError", () => {
  it("maps 42501 to a permission-denied message with verb/noun for context", () => {
    expect(friendlyPgError({ code: "42501", message: "permission denied for table folders" }, "folder")
      .message).toMatch(/permission denied.*create a folder/i);
    expect(friendlyPgError({ code: "42501", message: "permission denied for table folders" }, "folder")
      .kind).toBe("permission");

    expect(friendlyPgError({ code: "42501", message: "permission denied" }, "lock")
      .message).toMatch(/permission denied.*lock.*this file/i);
  });

  it("maps 23505 to a context-specific 'already exists' phrasing", () => {
    expect(friendlyPgError({ code: "23505", message: "duplicate key" }, "folder").message)
      .toMatch(/folder.*already exists/i);
    expect(friendlyPgError({ code: "23505", message: "duplicate key" }, "file").message)
      .toMatch(/file.*already exists/i);
    expect(friendlyPgError({ code: "23505", message: "duplicate key" }, "vault").message)
      .toMatch(/vault.*already exists/i);
    expect(friendlyPgError({ code: "23505", message: "duplicate key" }, "lock").message)
      .toMatch(/already checked out/i);
  });

  it("maps 23503 (FK violation) to a refresh-and-retry message", () => {
    expect(friendlyPgError({ code: "23503", message: "fk" }, "file").message)
      .toMatch(/referenced.*deleted.*refresh/i);
    expect(friendlyPgError({ code: "23503", message: "fk" }, "file").kind)
      .toBe("not-found");
  });

  it("maps PGRST116 to 'Item not found'", () => {
    expect(friendlyPgError({ code: "PGRST116", message: "no rows" }).message).toBe("Item not found.");
    expect(friendlyPgError({ code: "PGRST116", message: "no rows" }).kind).toBe("not-found");
  });

  it("maps JWT/auth errors (PGRST301 or status 401) to a session-expired message", () => {
    expect(friendlyPgError({ code: "PGRST301", message: "jwt expired" }).message)
      .toMatch(/session.*expired.*sign in/i);
    expect(friendlyPgError({ status: 401, message: "" }).kind).toBe("auth");
  });

  it("passes through P0001 RAISE EXCEPTION messages from RPCs, trimming SQLSTATE suffix", () => {
    // pdm.check_in raises "no active lock for this file" — that's a hand-
    // authored message we want users to see verbatim. The friendly mapper
    // must NOT replace it with a canned permission message.
    const got = friendlyPgError(
      { code: "P0001", message: "no active lock for this file (SQLSTATE P0001)" },
      "version",
    );
    expect(got.message).toBe("no active lock for this file");
    expect(got.kind).toBe("permission");
  });

  it("passes through unmapped codes verbatim (don't mask diagnostic detail)", () => {
    expect(friendlyPgError({ code: "XX999", message: "internal error: vacuum freeze" }).message)
      .toBe("internal error: vacuum freeze");
    expect(friendlyPgError({ code: "XX999", message: "internal error" }).kind).toBe("unknown");
  });

  it("handles native Error objects (non-Supabase)", () => {
    expect(friendlyPgError(new Error("network blip")).message).toBe("network blip");
    expect(friendlyPgError(new Error("network blip")).kind).toBe("unknown");
  });

  it("handles null/undefined input safely", () => {
    expect(friendlyPgError(null).message).toBe("Unknown error");
    expect(friendlyPgError(undefined).kind).toBe("unknown");
  });

  it("23502 (not-null) is mapped to missing-field", () => {
    expect(friendlyPgError({ code: "23502", message: "" }).kind).toBe("missing-field");
  });

  it("23514 (check) is mapped to constraint", () => {
    expect(friendlyPgError({ code: "23514", message: "" }).kind).toBe("constraint");
  });
});
