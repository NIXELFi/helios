import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedVault(adminId: string): Promise<{ vaultId: string; folderId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, created_by: adminId })
    .select().single();
  const { data: folder } = await svc
    .from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  return { vaultId: v!.id, folderId: folder!.id };
}

async function addFile(vaultId: string, folderId: string, name: string): Promise<string> {
  const svc = serviceClient();
  const { data: f } = await svc
    .from("files").insert({ vault_id: vaultId, folder_id: folderId, name }).select().single();
  return f!.id;
}

/** Acquire a lock + check in `fileId`, returning the new version id. */
async function checkIn(client: any, editorId: string, fileId: string, sha: string): Promise<string> {
  await client.from("locks").insert({ file_id: fileId, user_id: editorId });
  const { data, error } = await client.rpc("pdm_check_in", {
    p_file_id: fileId, p_sha256: sha, p_size: 1, p_comment: null,
  });
  if (error) throw new Error(error.message);
  return data.id;
}

describe("pdm.record_refs()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("records a resolved child ref pinned to the child's latest version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const childId = await addFile(vaultId, folderId, "frame-rail.sldprt");
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const childVer = await checkIn(c, editor.id, childId, "c".repeat(64));
    const parentVer = await checkIn(c, editor.id, parentId, "d".repeat(64));

    const { data, error } = await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["..\\parts\\frame-rail.sldprt"],
    });
    expect(error).toBeNull();
    expect(data).toBe(1);

    const svc = serviceClient();
    const { data: rows } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(rows).toHaveLength(1);
    expect(rows![0].child_file_id).toBe(childId);
    expect(rows![0].child_version_id).toBe(childVer);
  });

  it("keeps an unresolved hint (no matching file) with NULL child ids", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const parentVer = await checkIn(c, editor.id, parentId, "e".repeat(64));

    const { data } = await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["..\\parts\\does-not-exist.sldprt"],
    });
    expect(data).toBe(1);

    const svc = serviceClient();
    const { data: rows } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(rows).toHaveLength(1);
    expect(rows![0].child_file_id).toBeNull();
    expect(rows![0].child_version_id).toBeNull();
    expect(rows![0].child_path_hint).toMatch(/does-not-exist\.sldprt/);
  });

  it("rejects recording refs for a version the caller did not author", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const other = await createTestUser(uniqueEmail("other"));
    await setRole(other.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const parentVer = await checkIn(c, editor.id, parentId, "f".repeat(64));

    const oc = await signInAs(other.email!);
    const { error } = await oc.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer, p_child_hints: [],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);
  });

  it("is idempotent — re-recording replaces, does not duplicate", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const parentVer = await checkIn(c, editor.id, parentId, "0".repeat(64));

    await c.rpc("pdm_record_refs", { p_parent_version_id: parentVer, p_child_hints: ["a.sldprt"] });
    await c.rpc("pdm_record_refs", { p_parent_version_id: parentVer, p_child_hints: ["a.sldprt", "b.sldprt"] });

    const svc = serviceClient();
    const { data: rows } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(rows).toHaveLength(2);
  });
});
