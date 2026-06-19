import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/** Creates a vault owned by adminId, a folder, and one file. Returns {vaultId, fileId}. */
async function seedFile(adminId: string): Promise<{ vaultId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}`, created_by: adminId })
    .select()
    .single();
  const { data: f } = await svc
    .from("folders")
    .insert({ vault_id: v!.id, name: "parts" })
    .select()
    .single();
  const { data: file } = await svc
    .from("files")
    .insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" })
    .select()
    .single();
  return { vaultId: v!.id, fileId: file!.id };
}

describe("pdm.delete_file() — force-unlock audit attribution", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("admin deleting a file checked out by another user sets force_released_by and writes a force_unlock audit row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { fileId } = await seedFile(admin.id);

    // Editor checks the file out.
    const eClient = await signInAs(editor.email!);
    const { data: lock, error: lockErr } = await eClient
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    expect(lockErr).toBeNull();

    // Admin deletes the file (force-releases the editor's lock).
    const aClient = await signInAs(admin.email!);
    const { error: delErr } = await aClient.rpc("pdm_delete_file", { p_file_id: fileId });
    expect(delErr).toBeNull();

    const svc = serviceClient();

    // The displaced lock row must have force_released_by = admin.
    const { data: lockRow } = await svc
      .from("locks")
      .select("released_at, force_released_by")
      .eq("id", lock!.id)
      .single();
    expect(lockRow!.released_at).not.toBeNull();
    expect(lockRow!.force_released_by).toBe(admin.id);

    // A force_unlock audit row must exist naming the displaced holder.
    const { data: auditRows } = await svc
      .from("audit_log")
      .select("user_id, action, target_type, target_id, payload")
      .eq("action", "force_unlock")
      .eq("target_id", lock!.id);
    expect(auditRows).not.toBeNull();
    expect(auditRows!.length).toBeGreaterThan(0);

    const row = auditRows![0];
    expect(row.user_id).toBe(admin.id);
    expect(row.target_type).toBe("lock");
    expect(row.payload.via).toBe("delete_file");
    expect(row.payload.displaced_holder).toBe(editor.id);

    // The normal delete audit row must also exist.
    const { data: deleteAudit } = await svc
      .from("audit_log")
      .select("action, payload")
      .eq("action", "delete")
      .eq("target_id", fileId);
    expect(deleteAudit).not.toBeNull();
    expect(deleteAudit!.length).toBeGreaterThan(0);
    expect(deleteAudit![0].payload.soft).toBe(true);
  });

  it("user deleting their own checked-out file does NOT create a force_unlock audit row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { fileId } = await seedFile(admin.id);

    // Editor checks the file out and then deletes it themselves.
    const eClient = await signInAs(editor.email!);
    const { data: lock, error: lockErr } = await eClient
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    expect(lockErr).toBeNull();

    const { error: delErr } = await eClient.rpc("pdm_delete_file", { p_file_id: fileId });
    expect(delErr).toBeNull();

    const svc = serviceClient();

    // The caller's own lock must have released_at set but force_released_by NULL.
    const { data: lockRow } = await svc
      .from("locks")
      .select("released_at, force_released_by")
      .eq("id", lock!.id)
      .single();
    expect(lockRow!.released_at).not.toBeNull();
    expect(lockRow!.force_released_by).toBeNull();

    // No force_unlock audit row must exist for this file's locks.
    const { data: forceAudit } = await svc
      .from("audit_log")
      .select("id")
      .eq("action", "force_unlock")
      .eq("target_id", lock!.id);
    expect(forceAudit).not.toBeNull();
    expect(forceAudit!.length).toBe(0);
  });
});
