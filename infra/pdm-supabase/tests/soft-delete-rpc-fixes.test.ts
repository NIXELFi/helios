import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// Regression for the 2026-06-22 soft-delete RPC back-ports:
//   * 20260622000400 — reresolve_refs_for_file excludes soft-deleted PARENT
//   * 20260622000500 — add_and_lock resurrect re-anchors soft-deleted ancestors
//   * 20260622000600 — import_version resurrects a soft-deleted file
//
// Style mirrors refs-lifecycle-fixes.test.ts.

async function seedVault(adminId: string): Promise<{ vaultId: string; folderId: string }> {
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
  return { vaultId: v!.id, folderId: folder!.id };
}

async function addFile(vaultId: string, folderId: string | null, name: string): Promise<string> {
  const svc = serviceClient();
  const { data: f } = await svc
    .from("files")
    .insert({ vault_id: vaultId, folder_id: folderId, name })
    .select()
    .single();
  return f!.id;
}

async function checkIn(
  client: ReturnType<typeof serviceClient>,
  editorId: string,
  fileId: string,
  sha: string,
): Promise<string> {
  await client.from("locks").insert({ file_id: fileId, user_id: editorId });
  const { data, error } = await client.rpc("pdm_check_in", {
    p_file_id: fileId,
    p_sha256: sha,
    p_size: 1,
    p_comment: null,
  });
  if (error) throw new Error(error.message);
  return (data as any).id as string;
}

// ---------------------------------------------------------------------------
// Bug 5 — reresolve_refs_for_file excludes refs owned by a soft-deleted PARENT
// ---------------------------------------------------------------------------

describe("reresolve_refs_for_file: skips refs owned by a soft-deleted PARENT (20260622000400)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("does NOT resolve a soft-deleted parent's dangling ref when a matching live child appears", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const svc = serviceClient();
    const c = await signInAs(editor.email!);

    // Parent assembly with a ref naming a child that does not yet exist (dangling).
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");
    const parentVer = await checkIn(c, editor.id, parentId, "p".repeat(64));
    await svc.from("refs").insert({
      parent_version_id: parentVer,
      child_path_hint: "widget.sldprt",
      child_file_id: null,
      child_version_id: null,
    });

    // Soft-delete the PARENT assembly (it goes to the recycle bin).
    await svc
      .from("files")
      .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
      .eq("id", parentId);

    // Now a live child with the matching basename is created + checked in. Its
    // insert/latest triggers run reresolve_refs_for_file. Without the
    // pf.deleted_at guard, the deleted parent's dangling ref would re-resolve.
    const childId = await addFile(vaultId, folderId, "widget.sldprt");
    await checkIn(c, editor.id, childId, "w".repeat(64));

    const { data: refs } = await svc
      .from("refs")
      .select("child_file_id")
      .eq("parent_version_id", parentVer);
    // Parent is soft-deleted → its ref must stay unresolved.
    expect(refs![0].child_file_id).toBeNull();
  });

  it("DOES resolve a LIVE parent's dangling ref when a matching live child appears (control)", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const svc = serviceClient();
    const c = await signInAs(editor.email!);

    const parentId = await addFile(vaultId, folderId, "asm-live.sldasm");
    const parentVer = await checkIn(c, editor.id, parentId, "q".repeat(64));
    await svc.from("refs").insert({
      parent_version_id: parentVer,
      child_path_hint: "gizmo.sldprt",
      child_file_id: null,
      child_version_id: null,
    });

    // Parent stays LIVE. The new child must resolve the dangling ref.
    const childId = await addFile(vaultId, folderId, "gizmo.sldprt");
    await checkIn(c, editor.id, childId, "g".repeat(64));

    const { data: refs } = await svc
      .from("refs")
      .select("child_file_id")
      .eq("parent_version_id", parentVer);
    expect(refs![0].child_file_id).toBe(childId);
  });
});

// ---------------------------------------------------------------------------
// Bug 6 — add_and_lock resurrect path re-anchors soft-deleted ancestor folders
// ---------------------------------------------------------------------------

describe("add_and_lock: resurrect re-anchors soft-deleted ancestor folders (20260622000500)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("clears deleted_at on the file AND its soft-deleted parent folder on re-add", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const svc = serviceClient();

    // A file in the folder, then soft-delete BOTH the file and its parent folder
    // (as delete_folder would for an admin-deleted subtree).
    const fileId = await addFile(vaultId, folderId, "rib.sldprt");
    const now = new Date().toISOString();
    await svc.from("files").update({ deleted_at: now, deleted_by: admin.id }).eq("id", fileId);
    await svc.from("folders").update({ deleted_at: now, deleted_by: admin.id }).eq("id", folderId);

    // Editor re-adds the same name in the same folder → resurrect path.
    const c = await signInAs(editor.email!);
    const { data, error } = await c.rpc("pdm_add_and_lock", {
      p_vault_id: vaultId,
      p_folder_id: folderId,
      p_name: "rib.sldprt",
      p_sha256: "r".repeat(64),
      p_size: 1,
      p_comment: null,
    });
    expect(error).toBeNull();
    expect((data as any).file_id).toBe(fileId);
    expect((data as any).created).toBe(false);

    // The file must be live again.
    const { data: file } = await svc.from("files").select("deleted_at").eq("id", fileId).single();
    expect(file!.deleted_at).toBeNull();

    // And the ancestor folder must have been re-anchored (live), or the file
    // would be orphaned / invisible in the browse tree.
    const { data: folder } = await svc.from("folders").select("deleted_at").eq("id", folderId).single();
    expect(folder!.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bug 7 — import_version resurrects a soft-deleted file
// ---------------------------------------------------------------------------

describe("import_version: resurrects a soft-deleted file (20260622000600)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("clears the tombstone and chains the imported version onto the live file", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const { vaultId, folderId } = await seedVault(admin.id);

    const svc = serviceClient(); // service_role — required to call import_version

    // An existing file with a version, then soft-delete it (recycle bin).
    const fileId = await addFile(vaultId, folderId, "imported.sldprt");
    const { data: v1 } = await svc
      .from("versions")
      .insert({ file_id: fileId, version_num: 1, sha256: "a".repeat(64), size_bytes: 1, author_id: null })
      .select()
      .single();
    await svc.from("files").update({ latest_version_id: v1!.id }).eq("id", fileId);
    await svc
      .from("files")
      .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
      .eq("id", fileId);

    // Import a NEW version of the same (vault, folder, name) via service_role.
    const { data, error } = await svc.schema("public").rpc("pdm_import_version", {
      p_vault_id: vaultId,
      p_folder_id: folderId,
      p_name: "imported.sldprt",
      p_sha256: "b".repeat(64),
      p_size: 2,
      p_comment: "import 2",
      p_created_at: new Date().toISOString(),
      p_import_metadata: { origin: "test" },
    });
    expect(error).toBeNull();
    expect((data as any).file_id).toBe(fileId); // chained onto the same file
    expect((data as any).created).toBe(true);
    expect((data as any).resurrected).toBe(true);

    // The file must be LIVE again (not chained onto an invisible tombstone).
    const { data: file } = await svc.from("files").select("deleted_at, latest_version_id").eq("id", fileId).single();
    expect(file!.deleted_at).toBeNull();
    expect(file!.latest_version_id).toBe((data as any).version_id);
  });

  it("re-anchors a soft-deleted ancestor folder on resurrect", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const { vaultId, folderId } = await seedVault(admin.id);

    const svc = serviceClient();

    const fileId = await addFile(vaultId, folderId, "deep.sldprt");
    const { data: v1 } = await svc
      .from("versions")
      .insert({ file_id: fileId, version_num: 1, sha256: "c".repeat(64), size_bytes: 1, author_id: null })
      .select()
      .single();
    await svc.from("files").update({ latest_version_id: v1!.id }).eq("id", fileId);
    const now = new Date().toISOString();
    await svc.from("files").update({ deleted_at: now, deleted_by: admin.id }).eq("id", fileId);
    await svc.from("folders").update({ deleted_at: now, deleted_by: admin.id }).eq("id", folderId);

    const { error } = await svc.schema("public").rpc("pdm_import_version", {
      p_vault_id: vaultId,
      p_folder_id: folderId,
      p_name: "deep.sldprt",
      p_sha256: "d".repeat(64),
      p_size: 2,
      p_comment: "import",
      p_created_at: new Date().toISOString(),
      p_import_metadata: null,
    });
    expect(error).toBeNull();

    const { data: folder } = await svc.from("folders").select("deleted_at").eq("id", folderId).single();
    expect(folder!.deleted_at).toBeNull();
  });
});
