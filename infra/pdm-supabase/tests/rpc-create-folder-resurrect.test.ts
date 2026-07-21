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
 * 20260721000000: pdm_create_folder (resurrect-or-create) + pdm_cleanup_empty_folder.
 *
 * The pdm.folders unique indexes span live AND soft-deleted rows, so a
 * recycle-bin tombstone used to make its (vault, parent, name) slot permanently
 * uncreatable (audit M2). The RPC returns the live row when one exists,
 * resurrects a tombstone EMPTY (old contents stay in the bin), or inserts.
 * cleanup_empty_folder is the failure-path undo for ensureFolderHierarchy
 * (audit M5): hard-deletes a never-referenced husk, re-tombstones a
 * resurrected folder whose bin content still points at it, refuses live content.
 */

type CreateFolderResult = {
  folder: { id: string; deleted_at: string | null; name: string };
  created: boolean;
  resurrected: boolean;
};

async function seedVault(ownerId: string): Promise<string> {
  const svc = serviceClient();
  const { data: v, error } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, created_by: ownerId })
    .select()
    .single();
  if (error) throw error;
  return v!.id;
}

describe("pdm_create_folder — resurrect-or-create", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("creates, is idempotent on a live duplicate, and rejects viewers", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");
    const vaultId = await seedVault(admin.id);

    const e = await signInAs(editor.email!);
    const { data: first, error: err1 } = await e.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Chassis",
    });
    expect(err1).toBeNull();
    const r1 = first as CreateFolderResult;
    expect(r1.created).toBe(true);
    expect(r1.resurrected).toBe(false);

    // Same name again → the live row comes back, nothing new is created.
    const { data: second } = await e.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Chassis",
    });
    const r2 = second as CreateFolderResult;
    expect(r2.created).toBe(false);
    expect(r2.folder.id).toBe(r1.folder.id);

    const v = await signInAs(viewer.email!);
    const { error: viewerErr } = await v.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Aero",
    });
    expect(viewerErr).not.toBeNull();
    expect(viewerErr!.message).toMatch(/editor or admin/i);
  });

  it("resurrects a tombstone empty — the M2 case a direct INSERT still fails", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const vaultId = await seedVault(admin.id);
    const svc = serviceClient();

    const a = await signInAs(admin.email!);
    const { data: made } = await a.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Suspension",
    });
    const folderId = (made as CreateFolderResult).folder.id;

    // Put a file in it, then soft-delete the folder (admin: it has a live file).
    const { data: f, error: fErr } = await svc.from("files").insert({
      vault_id: vaultId, folder_id: folderId, name: "arm.sldprt",
      created_by: admin.id, published_at: new Date().toISOString(),
    }).select().single();
    expect(fErr).toBeNull();
    const { error: delErr } = await a.rpc("pdm_delete_folder", { p_folder_id: folderId });
    expect(delErr).toBeNull();

    // The tombstone still owns the unique slot: a direct INSERT (the old client
    // path) fails — this is exactly the bug the RPC exists to fix.
    const { error: insErr } = await svc.from("folders").insert({
      vault_id: vaultId, parent_id: null, name: "Suspension",
    });
    expect(insErr).not.toBeNull();

    // The RPC resurrects THAT row, empty: same id, live again, file stays deleted.
    const { data: back, error: backErr } = await a.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Suspension",
    });
    expect(backErr).toBeNull();
    const r = back as CreateFolderResult;
    expect(r.resurrected).toBe(true);
    expect(r.folder.id).toBe(folderId);

    const { data: row } = await svc.from("folders").select("deleted_at,delete_batch").eq("id", folderId).single();
    expect(row!.deleted_at).toBeNull();
    expect(row!.delete_batch).toBeNull();
    const { data: fileRow } = await svc.from("files").select("deleted_at").eq("id", f!.id).single();
    expect(fileRow!.deleted_at).not.toBeNull(); // old contents remain in the bin
  });

  it("rejects names that would traverse or inject path segments", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const vaultId = await seedVault(admin.id);
    const a = await signInAs(admin.email!);
    for (const bad of ["a/b", "..", ".", "  ", "a\\b"]) {
      const { error } = await a.rpc("pdm_create_folder", {
        p_vault_id: vaultId, p_parent_id: null, p_name: bad,
      });
      expect(error, `name ${JSON.stringify(bad)} should be rejected`).not.toBeNull();
    }
  });
});

describe("pdm_cleanup_empty_folder — the ensureFolderHierarchy undo", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("hard-deletes a never-referenced husk, refuses live content", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const vaultId = await seedVault(admin.id);
    const svc = serviceClient();
    const a = await signInAs(admin.email!);

    const { data: made } = await a.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Stranded",
    });
    const emptyId = (made as CreateFolderResult).folder.id;
    const { data: cleaned } = await a.rpc("pdm_cleanup_empty_folder", { p_folder_id: emptyId });
    expect(cleaned).toBe(true);
    const { data: gone } = await svc.from("folders").select("id").eq("id", emptyId);
    expect(gone).toHaveLength(0); // hard-deleted: nothing ever referenced it

    // A folder holding a live file must be refused, untouched.
    const { data: made2 } = await a.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Occupied",
    });
    const busyId = (made2 as CreateFolderResult).folder.id;
    await svc.from("files").insert({
      vault_id: vaultId, folder_id: busyId, name: "x.sldprt",
      created_by: admin.id, published_at: new Date().toISOString(),
    });
    const { data: refused } = await a.rpc("pdm_cleanup_empty_folder", { p_folder_id: busyId });
    expect(refused).toBe(false);
    const { data: still } = await svc.from("folders").select("deleted_at").eq("id", busyId).single();
    expect(still!.deleted_at).toBeNull();
  });

  it("re-tombstones a resurrected folder whose recycle-bin content still points at it", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const vaultId = await seedVault(admin.id);
    const svc = serviceClient();
    const a = await signInAs(admin.email!);

    const { data: made } = await a.rpc("pdm_create_folder", {
      p_vault_id: vaultId, p_parent_id: null, p_name: "Revived",
    });
    const folderId = (made as CreateFolderResult).folder.id;
    await svc.from("files").insert({
      vault_id: vaultId, folder_id: folderId, name: "old.sldprt",
      created_by: admin.id, published_at: new Date().toISOString(),
    });
    await a.rpc("pdm_delete_folder", { p_folder_id: folderId });
    await a.rpc("pdm_create_folder", { p_vault_id: vaultId, p_parent_id: null, p_name: "Revived" });

    // Cleanup after a failed add: deleted file still references the row, so it
    // must go BACK to a tombstone (hard delete would orphan the bin content).
    const { data: cleaned } = await a.rpc("pdm_cleanup_empty_folder", { p_folder_id: folderId });
    expect(cleaned).toBe(true);
    const { data: row } = await svc.from("folders").select("deleted_at").eq("id", folderId).single();
    expect(row!.deleted_at).not.toBeNull();
  });
});
