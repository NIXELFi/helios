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
 * 20260714010000: default-deny for accounts with no org role. A signed-in
 * user with NO pdm.user_roles row and NO pm role membership must see nothing —
 * no vault list, no pm reference tables, no dashboard photos, no games scores.
 * Any pdm row or pm membership flips pm.is_org_member() and restores reads.
 */
describe("org default-deny (no role = no reads)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a role-less user sees no vaults, pm reference tables, or games scores", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const nobody = await createTestUser(uniqueEmail("nobody"));

    const svc = serviceClient();
    await svc.from("vaults").insert({ name: `v-${Date.now()}`, created_by: admin.id });
    await svc.schema("games").from("scores").insert({
      user_id: admin.id, game_id: "snake", score: 42,
    }).select();

    const c = await signInAs(nobody.email!);

    const { data: vaults } = await c.from("vaults").select("id");
    expect(vaults ?? []).toHaveLength(0);

    const { data: subteams } = await c.schema("pm").from("subteams").select("id");
    expect(subteams ?? []).toHaveLength(0);

    const { data: roles } = await c.schema("pm").from("roles").select("id");
    expect(roles ?? []).toHaveLength(0);

    const { data: scores } = await c.schema("games").from("scores").select("id");
    expect(scores ?? []).toHaveLength(0);

    // The access probe the client's "contact your team lead" gate uses.
    const { data: member, error: probeErr } = await c.schema("pm").rpc("is_org_member");
    expect(probeErr).toBeNull();
    expect(member).toBe(false);
  });

  it("a legacy pdm role (and only that) restores reads", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer"); // explicit grant, not auto-provisioned

    const svc = serviceClient();
    await svc.from("vaults").insert({ name: `v-${Date.now()}`, created_by: admin.id });

    const c = await signInAs(viewer.email!);
    const { data: vaults } = await c.from("vaults").select("id");
    expect(vaults?.length).toBe(1);

    const { data: member } = await c.schema("pm").rpc("is_org_member");
    expect(member).toBe(true);
  });

  it("signup no longer auto-provisions, so brand-new accounts probe as non-members", async () => {
    // createTestUser strips nothing here — there is nothing to strip anymore.
    const fresh = await createTestUser(uniqueEmail("fresh"));
    const c = await signInAs(fresh.email!);
    const { data: member } = await c.schema("pm").rpc("is_org_member");
    expect(member).toBe(false);
  });
});
