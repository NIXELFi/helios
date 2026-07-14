import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

const BUCKET = "vault-objects";

/**
 * 20260714000000: the pdm vault gates (is_member_in / can_edit_in /
 * is_admin_in + the storage INSERT policy) accept a pm role membership whose
 * role carries the matching vault.* capability, alongside legacy
 * pdm.user_roles rows. Before the bridge, an Org & Access grant (Engineer /
 * Lead / VP) never affected vault access at all.
 */

async function seedVaultWithFile(ownerId: string): Promise<{ vaultId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, created_by: ownerId })
    .select()
    .single();
  const { data: f } = await svc
    .from("files")
    .insert({
      vault_id: v!.id,
      folder_id: null,
      name: "part.sldprt",
      created_by: ownerId,
      published_at: new Date().toISOString(),
    })
    .select()
    .single();
  return { vaultId: v!.id, fileId: f!.id };
}

/** Grants a pm role membership directly (service role bypasses pm RLS).
 *  Subteam-scoped roles need a subteam row; reuse a seeded one or create it. */
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

describe("pm capability bridge into vault gates", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a pm Lead (vault.edit) with NO pdm role can lock files and upload to storage", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const lead = await createTestUser(uniqueEmail("lead")); // NO pdm.user_roles row
    await grantPmRole(lead.id, "lead");
    const { vaultId, fileId } = await seedVaultWithFile(admin.id);

    const c = await signInAs(lead.email!);

    // can_edit_in bridge — the locks INSERT policy.
    const { error: lockErr } = await c.from("locks").insert({ file_id: fileId, user_id: lead.id });
    expect(lockErr).toBeNull();

    // Storage INSERT policy bridge — the check-in/add upload path.
    const sha = "beadfeed".padEnd(64, "0");
    const { error: upErr } = await c.storage
      .from(BUCKET)
      .upload(`${sha.slice(0, 2)}/${sha}`, new Uint8Array([1, 2, 3]), {
        contentType: "application/octet-stream",
        upsert: false,
      });
    expect(upErr).toBeNull();

    // The client-facing capability probe agrees.
    const { data: canEdit } = await c.rpc("pdm_can_edit_in", { p_vault_id: vaultId });
    expect(canEdit).toBe(true);
  });

  it("a seeded pm Engineer (vault.view only) can read but NOT lock or upload", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const eng = await createTestUser(uniqueEmail("eng")); // NO pdm.user_roles row
    await grantPmRole(eng.id, "engineer");
    const { vaultId, fileId } = await seedVaultWithFile(admin.id);

    const c = await signInAs(eng.email!);

    // is_member_in bridge — vault contents are visible...
    const { data: files } = await c.from("files").select("id").eq("vault_id", vaultId);
    expect(files?.map((f: { id: string }) => f.id)).toContain(fileId);

    // ...but the seeded engineer role carries no vault.edit: writes stay denied.
    const { error: lockErr } = await c.from("locks").insert({ file_id: fileId, user_id: eng.id });
    expect(lockErr).not.toBeNull();

    const sha = "cafef00d".padEnd(64, "0");
    const { error: upErr } = await c.storage
      .from(BUCKET)
      .upload(`${sha.slice(0, 2)}/${sha}`, new Uint8Array([4, 5, 6]), {
        contentType: "application/octet-stream",
        upsert: false,
      });
    expect(upErr).not.toBeNull();
  });

  it("a user with no pdm role and no pm membership still has no access", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const nobody = await createTestUser(uniqueEmail("nobody"));
    const { vaultId, fileId } = await seedVaultWithFile(admin.id);

    const c = await signInAs(nobody.email!);

    const { data: files } = await c.from("files").select("id").eq("vault_id", vaultId);
    expect(files ?? []).toHaveLength(0);

    const { error: lockErr } = await c.from("locks").insert({ file_id: fileId, user_id: nobody.id });
    expect(lockErr).not.toBeNull();

    const sha = "deedcede".padEnd(64, "0");
    const { error: upErr } = await c.storage
      .from(BUCKET)
      .upload(`${sha.slice(0, 2)}/${sha}`, new Uint8Array([7, 8, 9]), {
        contentType: "application/octet-stream",
        upsert: false,
      });
    expect(upErr).not.toBeNull();
  });

  it("a pm Executive (vault.admin) with NO pdm role passes the admin gate", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const exec = await createTestUser(uniqueEmail("exec")); // NO pdm.user_roles row
    await grantPmRole(exec.id, "executive"); // org-scoped; seeded with vault.admin
    const { vaultId } = await seedVaultWithFile(admin.id);

    const c = await signInAs(exec.email!);
    const { data: isAdmin } = await c.rpc("pdm_is_admin_in", { p_vault_id: vaultId });
    expect(isAdmin).toBe(true);
  });

  it("legacy pdm.user_roles rows keep working unchanged (global editor)", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor"); // legacy path only, no pm membership
    const { fileId } = await seedVaultWithFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    expect(error).toBeNull();
  });
});
