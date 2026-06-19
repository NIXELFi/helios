import { describe, expect, it } from "vitest";
import { resolveHolderName } from "../WhoHasWhatScreen";

// Tests for the confirmed cross-vault holder-name resolution bug (M19).
// WhoHasWhatScreen only looked up holder names in the ACTIVE vault's user list;
// holders from other vaults resolved to a raw hex fragment instead of a name.
// resolveHolderName accepts multiple name sources (active-vault map + cross-vault
// people map) so every holder gets the best available label.

const ACTIVE_VAULT_USERS = new Map<string, string>([
  ["aaaabbbb-0000-0000-0000-000000000001", "Alice (active vault)"],
]);

const CROSS_VAULT_PEOPLE = new Map<string, string>([
  ["ccccdddd-0000-0000-0000-000000000002", "Bob (other vault)"],
]);

describe("resolveHolderName", () => {
  it("resolves a holder present in the active-vault user map", () => {
    const name = resolveHolderName(
      "aaaabbbb-0000-0000-0000-000000000001",
      [ACTIVE_VAULT_USERS, CROSS_VAULT_PEOPLE],
    );
    expect(name).toBe("Alice (active vault)");
  });

  it("resolves a cross-vault holder present ONLY in the global people map", () => {
    const name = resolveHolderName(
      "ccccdddd-0000-0000-0000-000000000002",
      [ACTIVE_VAULT_USERS, CROSS_VAULT_PEOPLE],
    );
    expect(name).toBe("Bob (other vault)");
  });

  it("prefers the first source when both maps contain the same user id", () => {
    const altPeople = new Map<string, string>([
      ["aaaabbbb-0000-0000-0000-000000000001", "Alice (people fallback)"],
    ]);
    const name = resolveHolderName(
      "aaaabbbb-0000-0000-0000-000000000001",
      [ACTIVE_VAULT_USERS, altPeople],
    );
    expect(name).toBe("Alice (active vault)");
  });

  it("returns a friendly placeholder — NEVER a raw hex id — when unknown in all sources", () => {
    const unknownId = "ffffffff-1111-2222-3333-444444444444";
    const result = resolveHolderName(unknownId, [ACTIVE_VAULT_USERS, CROSS_VAULT_PEOPLE]);
    // Must NOT be the raw UUID or a hex fragment
    expect(result).not.toBe(unknownId);
    expect(result).not.toMatch(/^[0-9a-f]{8}$/i);
    // Must be a non-empty human-readable string
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/unknown|member/i);
  });

  it("works with a single source map (no cross-vault map provided)", () => {
    const name = resolveHolderName(
      "aaaabbbb-0000-0000-0000-000000000001",
      [ACTIVE_VAULT_USERS],
    );
    expect(name).toBe("Alice (active vault)");
  });

  it("works with zero source maps and still returns the friendly placeholder", () => {
    const result = resolveHolderName("ffffffff-0000-0000-0000-000000000000", []);
    expect(result).toMatch(/unknown|member/i);
  });

  it("returns the friendly placeholder for an empty userId string", () => {
    const result = resolveHolderName("", [ACTIVE_VAULT_USERS]);
    expect(result).toMatch(/unknown|member/i);
  });
});
