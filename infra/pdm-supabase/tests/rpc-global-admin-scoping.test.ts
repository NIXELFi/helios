import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  setVaultRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// Regression for C-3 (20260622000100_pdm_is_global_admin):
//
// pdm.is_admin() tested `role in ('owner','admin')` with NO vault_id filter, so a
// PER-VAULT admin (role='admin', vault_id=<X> — mintable by an owner via
// set_user_role) satisfied every global-admin gate. This let a per-vault admin:
//   * admin_delete_user  — irreversibly delete ANY non-admin user org-wide
//   * admin_update_user  — overwrite any non-admin user's metadata globally
//   * admin_list_users   — read the entire org user list + emails
//   * list_vault_roles   — read the roster of vaults they have no role in
//
// The fix introduces pdm.is_global_admin() (owner/admin AND vault_id IS NULL) and
// gates the first three on it; list_vault_roles uses is_global_admin() for its
// first disjunct only, so a per-vault admin still sees THEIR OWN vault.

const vaultName = () => `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedVault(ownerId: string): Promise<string> {
  const svc = serviceClient();
  const { data: v, error } = await svc
    .from("vaults")
    .insert({ name: vaultName(), created_by: ownerId })
    .select()
    .single();
  if (error) throw new Error(`seed vault: ${error.message}`);
  return v!.id;
}

describe("global-admin scoping — per-vault admin is rejected from global gates (C-3)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("admin_delete_user rejects a PER-VAULT admin deleting any user", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const vaultId = await seedVault(owner.id);

    // A legitimate per-vault admin (admin in vaultId only, NO global row).
    const vaultAdmin = await createTestUser(uniqueEmail("vadmin"));
    await setVaultRole(vaultAdmin.id, "admin", vaultId);

    const victim = await createTestUser(uniqueEmail("victim"));
    await setRole(victim.id, "editor");

    const vc = await signInAs(vaultAdmin.email!);
    const { error } = await vc.rpc("pdm_admin_delete_user", { p_target: victim.id });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);

    // The victim must still exist (the destructive escalation was blocked).
    const svc = serviceClient();
    const { data: list } = await svc.auth.admin.listUsers();
    expect(list.users.find((u) => u.id === victim.id)).toBeDefined();
  });

  it("admin_update_user rejects a PER-VAULT admin editing any user", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const vaultId = await seedVault(owner.id);

    const vaultAdmin = await createTestUser(uniqueEmail("vadmin"));
    await setVaultRole(vaultAdmin.id, "admin", vaultId);

    const victim = await createTestUser(uniqueEmail("victim"));
    await setRole(victim.id, "editor");

    const vc = await signInAs(vaultAdmin.email!);
    const { error } = await vc.rpc("pdm_admin_update_user", {
      p_target: victim.id,
      p_display_name: "hacked",
      p_subteam: "hacked",
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);

    // Metadata must be untouched.
    const svc = serviceClient();
    const { data: user } = await svc.auth.admin.getUserById(victim.id);
    expect(user.user?.user_metadata?.display_name).not.toBe("hacked");
  });

  it("admin_list_users rejects a PER-VAULT admin (cross-vault PII disclosure)", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const vaultId = await seedVault(owner.id);

    const vaultAdmin = await createTestUser(uniqueEmail("vadmin"));
    await setVaultRole(vaultAdmin.id, "admin", vaultId);

    const vc = await signInAs(vaultAdmin.email!);
    const { error } = await vc.rpc("pdm_admin_list_users");

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);
  });

  it("list_vault_roles rejects a PER-VAULT admin for ANOTHER vault", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const vaultA = await seedVault(owner.id);
    const vaultB = await seedVault(owner.id);

    // Admin in vault A only.
    const vaultAdmin = await createTestUser(uniqueEmail("vadmin"));
    await setVaultRole(vaultAdmin.id, "admin", vaultA);

    const vc = await signInAs(vaultAdmin.email!);

    // Their OWN vault: allowed (is_admin_in disjunct).
    const { error: ownErr } = await vc.rpc("pdm_list_vault_roles", { p_vault_id: vaultA });
    expect(ownErr).toBeNull();

    // ANOTHER vault: rejected (no longer admitted by the is_admin() disjunct).
    const { error: otherErr } = await vc.rpc("pdm_list_vault_roles", { p_vault_id: vaultB });
    expect(otherErr).not.toBeNull();
    expect(otherErr!.message).toMatch(/not authorized/i);
  });

  it("a GLOBAL admin still passes every gate (no regression)", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const vaultId = await seedVault(owner.id);

    const globalAdmin = await createTestUser(uniqueEmail("gadmin"));
    await setRole(globalAdmin.id, "admin"); // GLOBAL admin (vault_id NULL)

    const gc = await signInAs(globalAdmin.email!);

    const { error: listErr } = await gc.rpc("pdm_admin_list_users");
    expect(listErr).toBeNull();

    const { error: rolesErr } = await gc.rpc("pdm_list_vault_roles", { p_vault_id: vaultId });
    expect(rolesErr).toBeNull();
  });

  // Review follow-up (20260622000800): set_user_role/revoke_user_role gated a
  // GLOBAL (vault_id IS NULL) editor/viewer grant on bare is_admin(), so a
  // per-vault admin could mint a global editor role for anyone — routing around
  // the C-3 fix. The global branch now requires is_global_admin().
  it("set_user_role: a PER-VAULT admin cannot grant a GLOBAL role, but a GLOBAL admin can", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const vaultId = await seedVault(owner.id);

    const vaultAdmin = await createTestUser(uniqueEmail("vadmin"));
    await setVaultRole(vaultAdmin.id, "admin", vaultId);
    const globalAdmin = await createTestUser(uniqueEmail("gadmin"));
    await setRole(globalAdmin.id, "admin"); // GLOBAL admin (vault_id NULL)
    const target = await createTestUser(uniqueEmail("target"));

    const vc = await signInAs(vaultAdmin.email!);

    // Per-vault admin granting a GLOBAL editor role → rejected (the escalation).
    const { error: escErr } = await vc.rpc("pdm_set_user_role", {
      p_target: target.id, p_role: "editor", p_vault_id: null,
    });
    expect(escErr).not.toBeNull();
    expect(escErr!.message).toMatch(/not authorized/i);

    // No global role row was minted for the target.
    const svc = serviceClient();
    const { data: rows } = await svc
      .from("user_roles").select("vault_id").eq("user_id", target.id);
    expect((rows ?? []).some((r) => r.vault_id === null)).toBe(false);

    // Per-vault admin granting in THEIR OWN vault still works (is_admin_in).
    const { error: ownErr } = await vc.rpc("pdm_set_user_role", {
      p_target: target.id, p_role: "editor", p_vault_id: vaultId,
    });
    expect(ownErr).toBeNull();

    // A GLOBAL admin can still grant and revoke a global role (no regression).
    const gc = await signInAs(globalAdmin.email!);
    const { error: grantErr } = await gc.rpc("pdm_set_user_role", {
      p_target: target.id, p_role: "editor", p_vault_id: null,
    });
    expect(grantErr).toBeNull();
    const { error: revErr } = await gc.rpc("pdm_revoke_user_role", {
      p_target: target.id, p_vault_id: null,
    });
    expect(revErr).toBeNull();
  });
});
