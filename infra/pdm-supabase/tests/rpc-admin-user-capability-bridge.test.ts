import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/**
 * 20260721000100: pdm.admin_update_user / pdm.admin_delete_user accept org
 * CAPABILITY holders (org-scoped org.grant_roles — the predicate the Org &
 * Access "People & Roles" UI gates on) alongside legacy global pdm admins,
 * and the admin-tier target protection extends to the capability world: a
 * target holding org-scoped org.grant_roles / org.manage_admins is
 * owner-managed, exactly like a legacy global admin row.
 */

/** Grants a pm role membership directly (service role bypasses pm RLS). */
async function grantPmRole(userId: string, roleKey: string): Promise<void> {
  const svc = serviceClient().schema("pm");
  const { data: role, error: roleErr } = await svc
    .from("roles")
    .select("id,scope")
    .eq("key", roleKey)
    .single();
  if (roleErr) throw roleErr;

  let subteamId: string | null = null;
  if (role!.scope === "subteam") {
    const { data: st } = await svc.from("subteams").select("id").limit(1);
    if (st && st.length > 0) {
      subteamId = st[0].id;
    } else {
      const { data: created, error } = await svc
        .from("subteams")
        .insert({ name: "Test Subteam", code: "TST", slug: "test-subteam" })
        .select()
        .single();
      if (error) throw error;
      subteamId = created!.id;
    }
  }

  const { error } = await svc
    .from("role_memberships")
    .insert({ user_id: userId, role_id: role!.id, subteam_id: subteamId });
  if (error) throw error;
}

describe("pdm admin user RPCs — org capability bridge", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a capability-only Executive can edit and delete a regular member", async () => {
    const exec = await createTestUser(uniqueEmail("exec")); // NO pdm.user_roles row
    await grantPmRole(exec.id, "executive"); // seeded with org-scoped org.grant_roles
    const member = await createTestUser(uniqueEmail("member"));

    const c = await signInAs(exec.email!);

    const { error: updErr } = await c.rpc("pdm_admin_update_user", {
      p_target: member.id,
      p_display_name: "Renamed by exec",
      p_subteam: "Chassis",
    });
    expect(updErr).toBeNull();
    const { data: after } = await serviceClient().auth.admin.getUserById(member.id);
    expect(after!.user!.user_metadata.display_name).toBe("Renamed by exec");

    const { error: delErr } = await c.rpc("pdm_admin_delete_user", { p_target: member.id });
    expect(delErr).toBeNull();
    const { data: gone, error: goneErr } = await serviceClient().auth.admin.getUserById(member.id);
    expect(gone?.user ?? null).toBeNull();
    expect(goneErr).not.toBeNull();
  });

  it("a subteam Lead is NOT authorized (no org-scoped org.grant_roles)", async () => {
    const lead = await createTestUser(uniqueEmail("lead"));
    await grantPmRole(lead.id, "lead");
    const member = await createTestUser(uniqueEmail("member"));

    const c = await signInAs(lead.email!);
    const { error: updErr } = await c.rpc("pdm_admin_update_user", {
      p_target: member.id, p_display_name: "x", p_subteam: null,
    });
    expect(updErr).not.toBeNull();
    expect(updErr!.message).toMatch(/not authorized/i);
    const { error: delErr } = await c.rpc("pdm_admin_delete_user", { p_target: member.id });
    expect(delErr).not.toBeNull();
    expect(delErr!.message).toMatch(/not authorized/i);
  });

  it("admin-tier targets are owner-only: an Executive cannot act on a fellow Executive", async () => {
    const exec1 = await createTestUser(uniqueEmail("exec1"));
    await grantPmRole(exec1.id, "executive");
    const exec2 = await createTestUser(uniqueEmail("exec2"));
    await grantPmRole(exec2.id, "executive");

    const c = await signInAs(exec1.email!);
    const { error: updErr } = await c.rpc("pdm_admin_update_user", {
      p_target: exec2.id, p_display_name: "nope", p_subteam: null,
    });
    expect(updErr).not.toBeNull();
    expect(updErr!.message).toMatch(/only the owner can edit an admin/i);
    const { error: delErr } = await c.rpc("pdm_admin_delete_user", { p_target: exec2.id });
    expect(delErr).not.toBeNull();
    expect(delErr!.message).toMatch(/only the owner can delete an admin/i);
  });

  it("legacy paths are untouched: a legacy global admin still works, self-delete still refused", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member"));

    const c = await signInAs(admin.email!);
    const { error: updErr } = await c.rpc("pdm_admin_update_user", {
      p_target: member.id, p_display_name: "Renamed by admin", p_subteam: null,
    });
    expect(updErr).toBeNull();

    const { error: selfErr } = await c.rpc("pdm_admin_delete_user", { p_target: admin.id });
    expect(selfErr).not.toBeNull();
    expect(selfErr!.message).toMatch(/cannot delete your own account/i);
  });
});
