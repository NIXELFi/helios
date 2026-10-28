import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedVaultAndFile(adminId: string): Promise<{ vaultId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc
    .from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc
    .from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return { vaultId: v!.id, fileId: file!.id };
}

describe("pdm.check_in()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("inserts a version, releases the lock, updates files.latest_version_id, all atomically", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const sha = "a".repeat(64);
    const { data, error } = await c.rpc("pdm_check_in", {
      p_file_id: fileId,
      p_sha256: sha,
      p_size: 1234,
      p_comment: "first cut",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ file_id: fileId, version_num: 1, sha256: sha, size_bytes: 1234 });

    const svc = serviceClient();
    const { data: file } = await svc.from("files").select("latest_version_id").eq("id", fileId).single();
    expect(file!.latest_version_id).toBe(data.id);

    const { data: locks } = await svc.from("locks").select("released_at").eq("file_id", fileId);
    expect(locks!.every((l) => l.released_at !== null)).toBe(true);
  });

  it("increments version_num on each subsequent check-in", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);
    const c = await signInAs(editor.email!);

    for (let i = 1; i <= 3; i++) {
      await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
      const { data, error } = await c.rpc("pdm_check_in", {
        p_file_id: fileId,
        p_sha256: String(i).padStart(64, "0"),
        p_size: i,
        p_comment: `v${i}`,
      });
      expect(error).toBeNull();
      expect(data.version_num).toBe(i);
    }
  });

  it("rejects check-in after the caller's editor role is revoked, even holding the lock (v4.4.6)", async () => {
    // A lock acquired while an editor must not keep authorizing check-ins after
    // the role is gone (matches delete_file / set_revision re-check posture).
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    // Revoke the editor role (drop to viewer) while the lock is still held.
    await setRole(editor.id, "viewer");

    const { error } = await c.rpc("pdm_check_in", {
      p_file_id: fileId,
      p_sha256: "b".repeat(64),
      p_size: 1,
      p_comment: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/editor role required/i);
    void vaultId;
  });

  it("rejects check-in if the caller doesn't hold the lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.rpc("pdm_check_in", {
      p_file_id: fileId,
      p_sha256: "a".repeat(64),
      p_size: 1,
      p_comment: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/no active lock/i);
  });

  // 20261028000000: optional base-version guard + soft-deleted files.
  async function editorWithLock(): Promise<{ c: Awaited<ReturnType<typeof signInAs>>; fileId: string; editorId: string }> {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);
    const c = await signInAs(editor.email!);
    return { c, fileId, editorId: editor.id };
  }
  async function lockAndCheckIn(
    c: Awaited<ReturnType<typeof signInAs>>, fileId: string, editorId: string, sha: string, base?: string,
  ) {
    const { error: lockErr } = await c.from("locks").insert({ file_id: fileId, user_id: editorId });
    expect(lockErr).toBeNull();
    return c.rpc("pdm_check_in", {
      p_file_id: fileId, p_sha256: sha, p_size: 1, p_comment: null,
      ...(base !== undefined ? { p_base_sha256: base } : {}),
    });
  }

  it("refuses a check-in whose base is older than latest, keeping the lock and history", async () => {
    const { c, fileId, editorId } = await editorWithLock();
    const v1 = "1".repeat(64), v2 = "2".repeat(64), v3 = "3".repeat(64);
    expect((await lockAndCheckIn(c, fileId, editorId, v1)).error).toBeNull();
    expect((await lockAndCheckIn(c, fileId, editorId, v2, v1)).error).toBeNull();

    const { error } = await lockAndCheckIn(c, fileId, editorId, v3, v1);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/newer version \(v2\)/i);

    const svc = serviceClient();
    const { data: versions } = await svc.from("versions").select("version_num").eq("file_id", fileId);
    expect(versions!.length).toBe(2);
    const { data: active } = await svc.from("locks").select("id").eq("file_id", fileId).is("released_at", null);
    expect(active!.length).toBe(1);
  });

  it("accepts a stale base when the bytes equal latest (unchanged), and a missing base as before", async () => {
    const { c, fileId, editorId } = await editorWithLock();
    const v1 = "1".repeat(64), v2 = "2".repeat(64), v3 = "3".repeat(64);
    expect((await lockAndCheckIn(c, fileId, editorId, v1)).error).toBeNull();
    expect((await lockAndCheckIn(c, fileId, editorId, v2)).error).toBeNull();
    const unchanged = await lockAndCheckIn(c, fileId, editorId, v2, v1);
    expect(unchanged.error).toBeNull();
    expect(unchanged.data).toMatchObject({ version_num: 2 });
    const legacy = await lockAndCheckIn(c, fileId, editorId, v3);
    expect(legacy.error).toBeNull();
    expect(legacy.data).toMatchObject({ version_num: 3 });
  });

  it("refuses to lock or check in a file that is in the Deleted list", async () => {
    const { c, fileId, editorId } = await editorWithLock();
    // Lock while live, then soft-delete: check-in must refuse.
    await c.from("locks").insert({ file_id: fileId, user_id: editorId });
    const svc = serviceClient();
    await svc.from("files").update({ deleted_at: new Date().toISOString() }).eq("id", fileId);
    const { error } = await c.rpc("pdm_check_in", {
      p_file_id: fileId, p_sha256: "a".repeat(64), p_size: 1, p_comment: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/deleted list/i);

    // And no NEW lock can be taken on it.
    await svc.from("locks").update({ released_at: new Date().toISOString() }).eq("file_id", fileId);
    const { error: lockErr } = await c.from("locks").insert({ file_id: fileId, user_id: editorId });
    expect(lockErr).not.toBeNull();
  });
});
