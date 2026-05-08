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
});
