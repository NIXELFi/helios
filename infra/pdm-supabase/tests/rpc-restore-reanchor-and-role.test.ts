// Tests for 20260619000200_pdm_restore_reanchor_and_role.sql
//
// Covers:
//   H4 – restore_file on a file whose parent folder is soft-deleted re-anchors
//        the parent so the file is browsable after restore.
//   M5 – a user whose vault role was revoked after deleting a file cannot
//        restore it; an admin can; the original deleter who still has edit
//        access can.
//
// These are CI tests; they do NOT run locally (prod DB only).

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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Create a vault owned by adminId and return { vaultId, rootFolderId }. */
async function seedVault(
  adminId: string,
): Promise<{ vaultId: string; rootFolderId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, created_by: adminId })
    .select()
    .single();
  const { data: folder } = await svc
    .from("folders")
    .insert({ vault_id: v!.id, name: "root" })
    .select()
    .single();
  return { vaultId: v!.id, rootFolderId: folder!.id };
}

/** Insert a file row directly (published, no lock needed). */
async function insertFile(
  vaultId: string,
  folderId: string | null,
  name: string,
): Promise<string> {
  const svc = serviceClient();
  const { data: f } = await svc
    .from("files")
    .insert({ vault_id: vaultId, folder_id: folderId, name, published_at: new Date().toISOString() })
    .select()
    .single();
  return f!.id;
}

// ---------------------------------------------------------------------------
// H4: restore_file re-anchors soft-deleted ancestor folders
// ---------------------------------------------------------------------------

describe("H4 – restore_file re-anchors soft-deleted parent folder (20260619000200)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("restoring a file whose parent folder is soft-deleted clears the folder's deleted_at so the file is browsable", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const { vaultId, rootFolderId } = await seedVault(admin.id);

    const svc = serviceClient();

    // Create a subfolder inside root, then a file inside the subfolder.
    const { data: sub } = await svc
      .from("folders")
      .insert({ vault_id: vaultId, parent_id: rootFolderId, name: "sub" })
      .select()
      .single();
    const subId = sub!.id;
    const fileId = await insertFile(vaultId, subId, "part.sldprt");

    // Admin soft-deletes the subfolder (and by batch, the file inside it).
    const aClient = await signInAs(admin.email!);
    const { error: delErr } = await aClient.rpc("pdm_delete_folder", { p_folder_id: subId });
    expect(delErr).toBeNull();

    // Confirm the folder is deleted.
    const { data: folderBefore } = await svc
      .from("folders")
      .select("deleted_at")
      .eq("id", subId)
      .single();
    expect(folderBefore!.deleted_at).not.toBeNull();

    // Confirm the file is deleted.
    const { data: fileBefore } = await svc
      .from("files")
      .select("deleted_at")
      .eq("id", fileId)
      .single();
    expect(fileBefore!.deleted_at).not.toBeNull();

    // Admin restores the individual file (not the folder batch).
    // Because restore_file now re-anchors ancestors, the parent folder should
    // also become un-deleted.
    const { error: restErr } = await aClient.rpc("pdm_restore_file", { p_file_id: fileId });
    expect(restErr).toBeNull();

    // File is live.
    const { data: fileAfter } = await svc
      .from("files")
      .select("deleted_at")
      .eq("id", fileId)
      .single();
    expect(fileAfter!.deleted_at).toBeNull();

    // Parent folder is also live (re-anchored).
    const { data: folderAfter } = await svc
      .from("folders")
      .select("deleted_at")
      .eq("id", subId)
      .single();
    expect(folderAfter!.deleted_at).toBeNull();
  });

  it("re-anchors the full ancestor chain when multiple levels are soft-deleted", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const { vaultId, rootFolderId } = await seedVault(admin.id);

    const svc = serviceClient();

    // root → level1 → level2 → file
    const { data: lvl1 } = await svc
      .from("folders")
      .insert({ vault_id: vaultId, parent_id: rootFolderId, name: "lvl1" })
      .select()
      .single();
    const { data: lvl2 } = await svc
      .from("folders")
      .insert({ vault_id: vaultId, parent_id: lvl1!.id, name: "lvl2" })
      .select()
      .single();
    const fileId = await insertFile(vaultId, lvl2!.id, "deep.sldprt");

    // Delete lvl1 (takes the whole subtree including lvl2 + file).
    const aClient = await signInAs(admin.email!);
    await aClient.rpc("pdm_delete_folder", { p_folder_id: lvl1!.id });

    // Restore the individual file.
    const { error } = await aClient.rpc("pdm_restore_file", { p_file_id: fileId });
    expect(error).toBeNull();

    // Both intermediate folders should be un-deleted.
    const { data: rows } = await svc
      .from("folders")
      .select("id, deleted_at")
      .in("id", [lvl1!.id, lvl2!.id]);
    for (const row of rows!) {
      expect(row.deleted_at).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// M5: current-role check on restore_file
// ---------------------------------------------------------------------------

describe("M5 – restore_file requires current edit access for non-admin path (20260619000200)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a user whose role was revoked after deleting a file cannot restore it", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { vaultId, rootFolderId } = await seedVault(admin.id);
    const fileId = await insertFile(vaultId, rootFolderId, "part.sldprt");

    // Editor deletes the file while they have editor role (need a lock first).
    const svc = serviceClient();
    await svc.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const eClient = await signInAs(editor.email!);
    const { error: delErr } = await eClient.rpc("pdm_delete_file", { p_file_id: fileId });
    expect(delErr).toBeNull();

    // Admin demotes the editor to viewer.
    await setRole(editor.id, "viewer");

    // Now the ex-editor (now viewer) tries to restore — must be rejected.
    const { error: restErr } = await eClient.rpc("pdm_restore_file", { p_file_id: fileId });
    expect(restErr).not.toBeNull();
    expect(restErr!.message).toMatch(/edit access/i);
  });

  it("an admin can restore a file even when they were not the deleter", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { vaultId, rootFolderId } = await seedVault(admin.id);
    const fileId = await insertFile(vaultId, rootFolderId, "part.sldprt");

    // Editor deletes the file.
    const svc = serviceClient();
    await svc.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const eClient = await signInAs(editor.email!);
    await eClient.rpc("pdm_delete_file", { p_file_id: fileId });

    // Admin (different user) restores it.
    const aClient = await signInAs(admin.email!);
    const { error: restErr } = await aClient.rpc("pdm_restore_file", { p_file_id: fileId });
    expect(restErr).toBeNull();

    const { data: f } = await svc.from("files").select("deleted_at").eq("id", fileId).single();
    expect(f!.deleted_at).toBeNull();
  });

  it("the original deleter who still has editor role can restore the file", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { vaultId, rootFolderId } = await seedVault(admin.id);
    const fileId = await insertFile(vaultId, rootFolderId, "part.sldprt");

    // Editor deletes...
    const svc = serviceClient();
    await svc.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const eClient = await signInAs(editor.email!);
    await eClient.rpc("pdm_delete_file", { p_file_id: fileId });

    // ...and restores while still an editor.
    const { error: restErr } = await eClient.rpc("pdm_restore_file", { p_file_id: fileId });
    expect(restErr).toBeNull();

    const { data: f } = await svc.from("files").select("deleted_at").eq("id", fileId).single();
    expect(f!.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M5: current-role check on restore_folder
// ---------------------------------------------------------------------------

describe("M5 – restore_folder requires current edit access for non-admin path (20260619000200)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a user whose role was revoked after deleting a folder cannot restore it", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { vaultId, rootFolderId } = await seedVault(admin.id);
    const svc = serviceClient();
    const { data: sub } = await svc
      .from("folders")
      .insert({ vault_id: vaultId, parent_id: rootFolderId, name: "sub" })
      .select()
      .single();
    const subId = sub!.id;

    // Editor deletes the empty folder (editor role allows deleting empty folders).
    const eClient = await signInAs(editor.email!);
    const { error: delErr } = await eClient.rpc("pdm_delete_folder", { p_folder_id: subId });
    expect(delErr).toBeNull();

    // Admin demotes the editor to viewer.
    await setRole(editor.id, "viewer");

    // Ex-editor tries to restore — must be rejected.
    const { error: restErr } = await eClient.rpc("pdm_restore_folder", { p_folder_id: subId });
    expect(restErr).not.toBeNull();
    expect(restErr!.message).toMatch(/edit access/i);
  });

  it("an admin can restore a folder even when they were not the deleter", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { vaultId, rootFolderId } = await seedVault(admin.id);
    const svc = serviceClient();
    const { data: sub } = await svc
      .from("folders")
      .insert({ vault_id: vaultId, parent_id: rootFolderId, name: "sub" })
      .select()
      .single();
    const subId = sub!.id;

    // Editor deletes the folder.
    const eClient = await signInAs(editor.email!);
    await eClient.rpc("pdm_delete_folder", { p_folder_id: subId });

    // Admin (different user) restores it.
    const aClient = await signInAs(admin.email!);
    const { error: restErr } = await aClient.rpc("pdm_restore_folder", { p_folder_id: subId });
    expect(restErr).toBeNull();

    const { data: f } = await svc.from("folders").select("deleted_at").eq("id", subId).single();
    expect(f!.deleted_at).toBeNull();
  });

  it("the original deleter who still has editor role can restore the folder", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const { vaultId, rootFolderId } = await seedVault(admin.id);
    const svc = serviceClient();
    const { data: sub } = await svc
      .from("folders")
      .insert({ vault_id: vaultId, parent_id: rootFolderId, name: "sub" })
      .select()
      .single();
    const subId = sub!.id;

    // Editor deletes and immediately restores while still an editor.
    const eClient = await signInAs(editor.email!);
    await eClient.rpc("pdm_delete_folder", { p_folder_id: subId });
    const { error: restErr } = await eClient.rpc("pdm_restore_folder", { p_folder_id: subId });
    expect(restErr).toBeNull();

    const { data: f } = await svc.from("folders").select("deleted_at").eq("id", subId).single();
    expect(f!.deleted_at).toBeNull();
  });
});
