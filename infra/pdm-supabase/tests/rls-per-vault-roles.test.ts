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

const vaultName = () => `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedVaultWithFile(ownerId: string): Promise<{ vaultId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: vaultName(), created_by: ownerId }).select().single();
  const { data: f } = await svc.from("files").insert({ vault_id: v!.id, folder_id: null, name: "part.sldprt" }).select().single();
  return { vaultId: v!.id, fileId: f!.id };
}

describe("per-vault roles", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a per-vault editor can lock files in their vault but is denied in another", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); // no global role
    const a = await seedVaultWithFile(admin.id);
    const b = await seedVaultWithFile(admin.id);
    await setVaultRole(editor.id, "editor", a.vaultId); // editor only in vault A

    const c = await signInAs(editor.email!);
    const { error: inA } = await c.from("locks").insert({ file_id: a.fileId, user_id: editor.id });
    expect(inA).toBeNull(); // allowed in their vault

    const { error: inB } = await c.from("locks").insert({ file_id: b.fileId, user_id: editor.id });
    expect(inB).not.toBeNull(); // RLS denies in a vault where they have no role
  });

  it("a GLOBAL editor (vault_id NULL) can lock files in any vault", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor"); // global
    const a = await seedVaultWithFile(admin.id);
    const b = await seedVaultWithFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error: inA } = await c.from("locks").insert({ file_id: a.fileId, user_id: editor.id });
    const { error: inB } = await c.from("locks").insert({ file_id: b.fileId, user_id: editor.id });
    expect(inA).toBeNull();
    expect(inB).toBeNull();
  });

  it("a viewer (per-vault) cannot lock files in that vault", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    const a = await seedVaultWithFile(admin.id);
    await setVaultRole(viewer.id, "viewer", a.vaultId);

    const c = await signInAs(viewer.email!);
    const { error } = await c.from("locks").insert({ file_id: a.fileId, user_id: viewer.id });
    expect(error).not.toBeNull();
  });

  it("set_user_role grants a per-vault editor role", async () => {
    const owner = await createTestUser(uniqueEmail("owner")); await setRole(owner.id, "owner");
    const target = await createTestUser(uniqueEmail("target"));
    const a = await seedVaultWithFile(owner.id);

    const oc = await signInAs(owner.email!);
    const { error } = await oc.rpc("pdm_set_user_role", { p_target: target.id, p_role: "editor", p_vault_id: a.vaultId });
    expect(error).toBeNull();

    const svc = serviceClient();
    const { data } = await svc.from("user_roles").select("role,vault_id").eq("user_id", target.id);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ role: "editor", vault_id: a.vaultId });
  });

  it("set_user_role with NO vault arg grants a GLOBAL role (2-arg back-compat path)", async () => {
    const owner = await createTestUser(uniqueEmail("owner")); await setRole(owner.id, "owner");
    const target = await createTestUser(uniqueEmail("target"));
    const oc = await signInAs(owner.email!);
    const { error } = await oc.rpc("pdm_set_user_role", { p_target: target.id, p_role: "editor" }); // 2-arg
    expect(error).toBeNull();
    const svc = serviceClient();
    const { data } = await svc.from("user_roles").select("role,vault_id").eq("user_id", target.id);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ role: "editor", vault_id: null });
  });

  it("list_vault_roles reports the effective role (per-vault row overrides global)", async () => {
    const owner = await createTestUser(uniqueEmail("owner")); await setRole(owner.id, "owner");
    const u = await createTestUser(uniqueEmail("u")); await setRole(u.id, "viewer"); // global viewer
    const a = await seedVaultWithFile(owner.id);
    await setVaultRole(u.id, "editor", a.vaultId); // editor in vault A specifically

    const oc = await signInAs(owner.email!);
    const { data, error } = await oc.rpc("pdm_list_vault_roles", { p_vault_id: a.vaultId });
    expect(error).toBeNull();
    const row = (data as any[]).find((r) => r.user_id === u.id);
    expect(row.role).toBe("editor");
    expect(row.scope).toBe("vault");
  });
});
