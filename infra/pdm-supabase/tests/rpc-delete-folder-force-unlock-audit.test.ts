import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// Regression for the delete_folder force-unlock attribution gap
// (20260622000300_pdm_delete_folder_force_unlock_audit).
//
// When an admin deletes a folder whose subtree contains files checked out by
// OTHER users, delete_folder previously released those locks with a bare
// `set released_at = now()` — no force_released_by, no force_unlock audit row.
// This back-ports the pdm.delete_file pattern (20260619000600): per-displaced-
// lock force_released_by + a force_unlock audit row naming the displaced holder.

/** Vault + folder + one file inside it. Returns ids. */
async function seedFolderFile(adminId: string): Promise<{ vaultId: string; folderId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, created_by: adminId })
    .select()
    .single();
  const { data: folder } = await svc
    .from("folders")
    .insert({ vault_id: v!.id, name: "parts" })
    .select()
    .single();
  const { data: file } = await svc
    .from("files")
    .insert({ vault_id: v!.id, folder_id: folder!.id, name: "x.sldprt" })
    .select()
    .single();
  return { vaultId: v!.id, folderId: folder!.id, fileId: file!.id };
}

describe("pdm.delete_folder() — force-unlock audit attribution", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("admin deleting a folder containing a file checked out by another user attributes + audits the force-unlock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { folderId, fileId } = await seedFolderFile(admin.id);

    // Editor checks the file out.
    const eClient = await signInAs(editor.email!);
    const { data: lock, error: lockErr } = await eClient
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    expect(lockErr).toBeNull();

    // Admin deletes the folder (force-releases the editor's lock). Only an admin
    // can delete a folder that contains a live file.
    const aClient = await signInAs(admin.email!);
    const { error: delErr } = await aClient.rpc("pdm_delete_folder", { p_folder_id: folderId });
    expect(delErr).toBeNull();

    const svc = serviceClient();

    // The displaced lock must have force_released_by = admin.
    const { data: lockRow } = await svc
      .from("locks")
      .select("released_at, force_released_by")
      .eq("id", lock!.id)
      .single();
    expect(lockRow!.released_at).not.toBeNull();
    expect(lockRow!.force_released_by).toBe(admin.id);

    // A force_unlock audit row must name the displaced holder, via delete_folder.
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
    expect(row.payload.via).toBe("delete_folder");
    expect(row.payload.folder_id).toBe(folderId);
    expect(row.payload.displaced_holder).toBe(editor.id);
  });

  it("admin deleting a folder containing their OWN checked-out file does NOT write a force_unlock row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");

    const { folderId, fileId } = await seedFolderFile(admin.id);

    // Admin checks out their own file, then deletes the folder.
    const aClient = await signInAs(admin.email!);
    const { data: lock, error: lockErr } = await aClient
      .from("locks")
      .insert({ file_id: fileId, user_id: admin.id })
      .select()
      .single();
    expect(lockErr).toBeNull();

    const { error: delErr } = await aClient.rpc("pdm_delete_folder", { p_folder_id: folderId });
    expect(delErr).toBeNull();

    const svc = serviceClient();

    // Own lock released, but force_released_by stays NULL.
    const { data: lockRow } = await svc
      .from("locks")
      .select("released_at, force_released_by")
      .eq("id", lock!.id)
      .single();
    expect(lockRow!.released_at).not.toBeNull();
    expect(lockRow!.force_released_by).toBeNull();

    // No force_unlock audit row for the caller's own lock.
    const { data: forceAudit } = await svc
      .from("audit_log")
      .select("id")
      .eq("action", "force_unlock")
      .eq("target_id", lock!.id);
    expect(forceAudit).not.toBeNull();
    expect(forceAudit!.length).toBe(0);
  });
});
