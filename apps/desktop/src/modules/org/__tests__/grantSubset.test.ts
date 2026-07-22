import { describe, it, expect } from "vitest";
import { canRevokeRole, grantableCapsPayload, roleCapsHeldInScope, type CanFn } from "../data/useOrgData";

// Build a `can(cap, subteamId?)` matching useMyCapabilities' resolver from a
// flat list of granted caps: subteam_id null ⇒ applies everywhere; otherwise
// only for that subteam.
function makeCan(grants: { capability_key: string; subteam_id: string | null }[]): CanFn {
  return (cap, subteamId) =>
    grants.some(
      (g) => g.capability_key === cap && (g.subteam_id === null || (!!subteamId && g.subteam_id === subteamId)),
    );
}

describe("roleCapsHeldInScope (grant-subset filtering, bug 3)", () => {
  it("offers an org role only when every cap is held org-wide", () => {
    const can = makeCan([
      { capability_key: "pm.view", subteam_id: null },
      { capability_key: "pm.edit", subteam_id: null },
    ]);
    expect(roleCapsHeldInScope(["pm.view", "pm.edit"], can, null)).toBe(true);
    // missing pm.admin org-wide → not grantable
    expect(roleCapsHeldInScope(["pm.view", "pm.admin"], can, null)).toBe(false);
  });

  it("offers a subteam role only into subteams where the granter holds every cap", () => {
    const can = makeCan([
      // org-wide cap counts in every subteam
      { capability_key: "pm.view", subteam_id: null },
      // subteam-scoped cap only in st-aero
      { capability_key: "pm.edit", subteam_id: "st-aero" },
    ]);
    const roleCaps = ["pm.view", "pm.edit"];
    // grantable into st-aero (holds both there)
    expect(roleCapsHeldInScope(roleCaps, can, "st-aero")).toBe(true);
    // NOT grantable into st-chassis (lacks pm.edit there) — this is the bug:
    // previously the dropdown offered the role for every subteam regardless.
    expect(roleCapsHeldInScope(roleCaps, can, "st-chassis")).toBe(false);
    // NOT grantable org-wide (pm.edit is only subteam-scoped)
    expect(roleCapsHeldInScope(roleCaps, can, null)).toBe(false);
  });

  it("an empty-cap role is always grantable", () => {
    const can = makeCan([]);
    expect(roleCapsHeldInScope([], can, null)).toBe(true);
    expect(roleCapsHeldInScope([], can, "st-aero")).toBe(true);
  });
});

describe("grantableCapsPayload (role-editor save, bug 2)", () => {
  it("drops disabled-but-selected caps the admin doesn't hold", () => {
    const can = makeCan([
      { capability_key: "pm.view", subteam_id: null },
      { capability_key: "pm.edit", subteam_id: null },
    ]);
    // The role had pm.admin (a cap the admin lacks) selected/disabled. Before the
    // fix, this whole set was sent and the server rejected the upsert, so the
    // admin could not edit ANY role containing a cap they lack.
    const selected = new Set(["pm.view", "pm.edit", "pm.admin"]);
    expect(grantableCapsPayload(selected, can).sort()).toEqual(["pm.edit", "pm.view"]);
  });

  it("passes through caps the admin holds unchanged", () => {
    const can = makeCan([
      { capability_key: "pm.view", subteam_id: null },
      { capability_key: "pm.edit", subteam_id: null },
    ]);
    const selected = new Set(["pm.view", "pm.edit"]);
    expect(grantableCapsPayload(selected, can).sort()).toEqual(["pm.edit", "pm.view"]);
  });

  it("only org-wide holdings count for the org-scoped role catalog", () => {
    const can = makeCan([{ capability_key: "pm.edit", subteam_id: "st-aero" }]);
    // pm.edit is held only in st-aero, not org-wide → must not be sent.
    expect(grantableCapsPayload(new Set(["pm.edit"]), can)).toEqual([]);
  });
});

describe("subteam-scoped Lead can grant (the missing plus button)", () => {
  // A Lead holds pm.grant_subteam_roles ONLY for their subteam. The old plus-
  // button gate called can("pm.grant_subteam_roles") with no subteam id, which
  // matches org-wide grants only — so the button never rendered for Leads even
  // though pm.grant_role accepts them. The gate now derives from the grantable
  // role set, whose per-subteam resolution these cases pin down.
  const lead = makeCan([
    { capability_key: "pm.view", subteam_id: "st-aero" },
    { capability_key: "pm.edit_tasks", subteam_id: "st-aero" },
    { capability_key: "pm.grant_subteam_roles", subteam_id: "st-aero" },
  ]);

  it("a scope-blind can() misses the Lead's grant capability (the old gate)", () => {
    expect(lead("pm.grant_subteam_roles")).toBe(false);
    expect(lead("pm.grant_subteam_roles", "st-aero")).toBe(true);
  });

  it("a member-tier role is grantable into the Lead's subteam but nowhere else", () => {
    const memberCaps = ["pm.view", "pm.edit_tasks"];
    expect(roleCapsHeldInScope(memberCaps, lead, "st-aero")).toBe(true);
    expect(roleCapsHeldInScope(memberCaps, lead, "st-chassis")).toBe(false);
    expect(roleCapsHeldInScope(memberCaps, lead, null)).toBe(false);
  });
});

describe("canRevokeRole (revoke-gate mirror)", () => {
  const lead = makeCan([{ capability_key: "pm.grant_subteam_roles", subteam_id: "st-aero" }]);
  const orgGranter = makeCan([{ capability_key: "org.grant_roles", subteam_id: null }]);
  const owner = makeCan([
    { capability_key: "org.grant_roles", subteam_id: null },
    { capability_key: "org.manage_admins", subteam_id: null },
  ]);

  it("a Lead can revoke only within their own subteam", () => {
    expect(canRevokeRole({ role: "member", subteam_id: "st-aero" }, lead)).toBe(true);
    expect(canRevokeRole({ role: "member", subteam_id: "st-chassis" }, lead)).toBe(false);
    expect(canRevokeRole({ role: "advisor", subteam_id: null }, lead)).toBe(false);
  });

  it("owner/executive chips need org.manage_admins, not just org.grant_roles", () => {
    expect(canRevokeRole({ role: "executive", subteam_id: null }, orgGranter)).toBe(false);
    expect(canRevokeRole({ role: "owner", subteam_id: null }, orgGranter)).toBe(false);
    expect(canRevokeRole({ role: "executive", subteam_id: null }, owner)).toBe(true);
  });

  it("an org granter can revoke org and subteam grants alike", () => {
    expect(canRevokeRole({ role: "advisor", subteam_id: null }, orgGranter)).toBe(true);
    expect(canRevokeRole({ role: "member", subteam_id: "st-aero" }, orgGranter)).toBe(true);
  });
});
