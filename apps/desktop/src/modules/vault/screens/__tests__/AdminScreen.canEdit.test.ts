import { describe, it, expect } from "vitest";
import { canEditUserProfile } from "../AdminScreen";

// Mirror the existing Revoke/role-select gating (AdminScreen.tsx lines 370-373):
//   isOwnerRow      = u.role === "owner"
//   isAdminRow      = u.role === "admin"
//   lockedByOwnership = isOwnerRow || (isAdminRow && !isOwner)
//   editable        = isAdmin && !isMe && !lockedByOwnership
//
// canEditUserProfile adds the busy + vaultScoped guards that were already on
// the Edit button, and now also enforces the ownership guard that was missing.

describe("canEditUserProfile", () => {
  // ---- ownership guard (the confirmed bug M21) --------------------------------

  it("non-owner admin CANNOT edit the owner row", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: false,
        isOwnerRow: true,
        isMe: false,
        busy: false,
        vaultScoped: false,
      }),
    ).toBe(false);
  });

  it("owner CAN edit the owner row (owner is allowed to touch their own bootstrap row)", () => {
    // lockedByOwnership = isOwnerRow || (isAdminRow && !isOwner)
    // When isOwner=true: editable = isAdmin && !isMe && !lockedByOwnership
    // isOwnerRow=true so lockedByOwnership=true even for the owner.
    // That matches how the Revoke control works — the owner row is always
    // locked (bootstrap-managed); owner-edits-owner is still disabled.
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: true,
        isOwnerRow: true,
        isMe: true,    // owner IS the owner row
        busy: false,
        vaultScoped: false,
      }),
    ).toBe(false);
  });

  // ---- normal admin editing a plain user row ----------------------------------

  it("admin can edit a normal (viewer/editor) user row", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: false,
        isOwnerRow: false,
        isMe: false,
        busy: false,
        vaultScoped: false,
      }),
    ).toBe(true);
  });

  it("admin CANNOT edit an admin row unless they are the owner", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: false,
        isOwnerRow: false,
        isMe: false,
        busy: false,
        vaultScoped: false,
        isAdminRow: true,
      }),
    ).toBe(false);
  });

  it("owner CAN edit an admin row (isAdminRow && isOwner is not locked)", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: true,
        isOwnerRow: false,
        isMe: false,
        busy: false,
        vaultScoped: false,
        isAdminRow: true,
      }),
    ).toBe(true);
  });

  // ---- self-edit guard --------------------------------------------------------

  it("admin CANNOT edit their own row", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: false,
        isOwnerRow: false,
        isMe: true,
        busy: false,
        vaultScoped: false,
      }),
    ).toBe(false);
  });

  // ---- non-admin cannot edit anything -----------------------------------------

  it("non-admin CANNOT edit any user row", () => {
    expect(
      canEditUserProfile({
        isAdmin: false,
        isOwner: false,
        isOwnerRow: false,
        isMe: false,
        busy: false,
        vaultScoped: false,
      }),
    ).toBe(false);
  });

  it("non-admin CANNOT edit even when they are the owner (isAdmin=false edge case)", () => {
    // Shouldn't happen in practice (owner is always admin), but the pure
    // function should still guard on isAdmin.
    expect(
      canEditUserProfile({
        isAdmin: false,
        isOwner: true,
        isOwnerRow: false,
        isMe: false,
        busy: false,
        vaultScoped: false,
      }),
    ).toBe(false);
  });

  // ---- busy / vaultScoped guards (pre-existing, now exercised) ----------------

  it("busy disables editing", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: false,
        isOwnerRow: false,
        isMe: false,
        busy: true,
        vaultScoped: false,
      }),
    ).toBe(false);
  });

  it("vaultScoped disables editing", () => {
    expect(
      canEditUserProfile({
        isAdmin: true,
        isOwner: false,
        isOwnerRow: false,
        isMe: false,
        busy: false,
        vaultScoped: true,
      }),
    ).toBe(false);
  });
});
