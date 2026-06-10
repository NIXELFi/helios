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

/** Seed a vault with one published file (+ a version and an active lock held
 *  by `lockHolderId` when given) via the service client. */
async function seedVault(creatorId: string, lockHolderId?: string) {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults")
    .insert({ name: vaultName(), created_by: creatorId }).select().single();
  const { data: folder } = await svc.from("folders")
    .insert({ vault_id: v!.id, name: "chassis" }).select().single();
  const { data: f } = await svc.from("files")
    .insert({
      vault_id: v!.id, folder_id: folder!.id, name: "frame.sldprt",
      created_by: creatorId, published_at: new Date().toISOString(),
    }).select().single();
  const { data: ver } = await svc.from("versions")
    .insert({ file_id: f!.id, version_num: 1, sha256: "a".repeat(64), size_bytes: 10, author_id: creatorId })
    .select().single();
  if (lockHolderId) {
    await svc.from("locks").insert({ file_id: f!.id, user_id: lockHolderId });
  }
  return { vaultId: v!.id, folderId: folder!.id, fileId: f!.id, versionId: ver!.id };
}

describe("vault-scoped reads (20260610100000)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a per-vault member reads their vault but NOT another vault's files/folders/versions/locks", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member")); // no global role
    const a = await seedVault(admin.id, admin.id);
    const b = await seedVault(admin.id, admin.id);
    await setVaultRole(member.id, "viewer", a.vaultId);

    const c = await signInAs(member.email!);

    const { data: filesA } = await c.from("files").select("id").eq("vault_id", a.vaultId);
    expect(filesA?.map((r) => r.id)).toContain(a.fileId);

    // Vault B is invisible across all four tables (RLS filters, no error).
    const { data: filesB } = await c.from("files").select("id").eq("vault_id", b.vaultId);
    expect(filesB ?? []).toHaveLength(0);
    const { data: foldersB } = await c.from("folders").select("id").eq("vault_id", b.vaultId);
    expect(foldersB ?? []).toHaveLength(0);
    const { data: versionsB } = await c.from("versions").select("id").eq("file_id", b.fileId);
    expect(versionsB ?? []).toHaveLength(0);
    const { data: locksB } = await c.from("locks").select("id").eq("file_id", b.fileId);
    expect(locksB ?? []).toHaveLength(0);
  });

  it("a GLOBAL role row (vault_id NULL) is authoritative in every vault", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer"); // global
    const a = await seedVault(admin.id);
    const b = await seedVault(admin.id);

    const c = await signInAs(viewer.email!);
    const { data: filesA } = await c.from("files").select("id").eq("vault_id", a.vaultId);
    const { data: filesB } = await c.from("files").select("id").eq("vault_id", b.vaultId);
    expect(filesA?.map((r) => r.id)).toContain(a.fileId);
    expect(filesB?.map((r) => r.id)).toContain(b.fileId);
  });

  it("a user with NO role reads nothing — not even versions or locks", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const stranger = await createTestUser(uniqueEmail("stranger"));
    const a = await seedVault(admin.id, admin.id);

    const c = await signInAs(stranger.email!);
    for (const [table, col, val] of [
      ["files", "vault_id", a.vaultId],
      ["folders", "vault_id", a.vaultId],
      ["versions", "file_id", a.fileId],
      ["locks", "file_id", a.fileId],
    ] as const) {
      const { data } = await c.from(table).select("*").eq(col, val);
      expect(data ?? []).toHaveLength(0);
    }
    // audit_log requires a role row too.
    const { data: audit } = await c.from("audit_log").select("id").limit(1);
    expect(audit ?? []).toHaveLength(0);
  });

  it("user_roles: non-admins see only their own rows", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const c = await signInAs(editor.email!);
    const { data: rows } = await c.from("user_roles").select("user_id");
    expect(rows ?? []).not.toHaveLength(0);
    expect((rows ?? []).every((r) => r.user_id === editor.id)).toBe(true);

    const a = await signInAs(admin.email!);
    const { data: adminRows } = await a.from("user_roles").select("user_id");
    expect((adminRows ?? []).some((r) => r.user_id === editor.id)).toBe(true);
  });
});

describe("recycle-bin restore RPCs", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("the deleter restores their own file; deleted_at clears; audit row lands", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const a = await seedVault(admin.id);
    const svc = serviceClient();

    const c = await signInAs(editor.email!);
    // Editor checks the file out, then soft-deletes it.
    await c.from("locks").insert({ file_id: a.fileId, user_id: editor.id });
    const { error: delErr } = await c.rpc("pdm_delete_file", { p_file_id: a.fileId });
    expect(delErr).toBeNull();

    const { error: restoreErr } = await c.rpc("pdm_restore_file", { p_file_id: a.fileId });
    expect(restoreErr).toBeNull();

    const { data: f } = await svc.from("files").select("deleted_at,deleted_by").eq("id", a.fileId).single();
    expect(f!.deleted_at).toBeNull();
    expect(f!.deleted_by).toBeNull();

    const { data: audit } = await svc.from("audit_log")
      .select("action").eq("target_id", a.fileId).order("ts", { ascending: true });
    expect(audit!.map((r) => r.action)).toEqual(expect.arrayContaining(["delete", "restore"]));
  });

  it("a non-deleter non-admin cannot restore someone else's deleted file", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const other = await createTestUser(uniqueEmail("other"));
    await setRole(other.id, "editor");
    const a = await seedVault(admin.id);
    const svc = serviceClient();

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: a.fileId, user_id: editor.id });
    await c.rpc("pdm_delete_file", { p_file_id: a.fileId });

    const o = await signInAs(other.email!);
    const { error } = await o.rpc("pdm_restore_file", { p_file_id: a.fileId });
    expect(error).not.toBeNull();

    const { data: f } = await svc.from("files").select("deleted_at").eq("id", a.fileId).single();
    expect(f!.deleted_at).not.toBeNull();
  });

  it("an admin restores anyone's deleted file", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const a = await seedVault(admin.id);
    const svc = serviceClient();

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: a.fileId, user_id: editor.id });
    await c.rpc("pdm_delete_file", { p_file_id: a.fileId });

    const ad = await signInAs(admin.email!);
    const { error } = await ad.rpc("pdm_restore_file", { p_file_id: a.fileId });
    expect(error).toBeNull();
    const { data: f } = await svc.from("files").select("deleted_at").eq("id", a.fileId).single();
    expect(f!.deleted_at).toBeNull();
  });

  it("folder delete cascades; restore_folder brings the folder and its files back", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await seedVault(admin.id);
    const svc = serviceClient();

    const ad = await signInAs(admin.email!);
    const { error: delErr } = await ad.rpc("pdm_delete_folder", { p_folder_id: a.folderId });
    expect(delErr).toBeNull();

    const { data: fileAfterDelete } = await svc.from("files").select("deleted_at").eq("id", a.fileId).single();
    expect(fileAfterDelete!.deleted_at).not.toBeNull();

    const { error: restoreErr } = await ad.rpc("pdm_restore_folder", { p_folder_id: a.folderId });
    expect(restoreErr).toBeNull();

    const { data: folderNow } = await svc.from("folders").select("deleted_at").eq("id", a.folderId).single();
    const { data: fileNow } = await svc.from("files").select("deleted_at").eq("id", a.fileId).single();
    expect(folderNow!.deleted_at).toBeNull();
    expect(fileNow!.deleted_at).toBeNull();
  });

  it("delete_file rejects a lock holder whose editing role was revoked (stale-lock fix)", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const a = await seedVault(admin.id);
    const svc = serviceClient();

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: a.fileId, user_id: editor.id });

    // Role revoked while the lock is still held.
    await svc.from("user_roles").delete().eq("user_id", editor.id);

    const { error } = await c.rpc("pdm_delete_file", { p_file_id: a.fileId });
    expect(error).not.toBeNull();
    const { data: f } = await svc.from("files").select("deleted_at").eq("id", a.fileId).single();
    expect(f!.deleted_at).toBeNull();
  });
});
