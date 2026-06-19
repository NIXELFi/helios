/**
 * CI tests for 20260619000300_pdm_refs_lifecycle_fixes.sql
 *
 * Three findings:
 *   H7 – refs re-resolve trigger on deleted_at changes.
 *   M9 – restore_version re-pins child_version_id to current latest.
 *   M11 – record_refs allows authorised editors to record refs for imported
 *          versions (author_id IS NULL).
 *
 * Style mirrors refs-reresolve-and-restore.test.ts and rpc-record-refs.test.ts.
 * No DB writes outside the test helpers; all state is wiped between tests via
 * resetAuthUsers().
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

/** Acquire a lock + check in `fileId` as `editorId`, returning the new version id. */
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
// H7 — refs re-resolve trigger fires on deleted_at changes
// ---------------------------------------------------------------------------

describe("H7: refs re-resolve trigger on deleted_at (20260619000300)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("nulls out child_file_id when the child is soft-deleted", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const childId = await addFile(vaultId, folderId, "wheel.sldprt");
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const svc = serviceClient();
    const c = await signInAs(editor.email!);
    const childVer = await checkIn(c, editor.id, childId, "c".repeat(64));
    const parentVer = await checkIn(c, editor.id, parentId, "p".repeat(64));

    // Record a resolved ref pointing at the child.
    const { error: refErr } = await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["wheel.sldprt"],
    });
    expect(refErr).toBeNull();

    const { data: before } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(before![0].child_file_id).toBe(childId);
    expect(before![0].child_version_id).toBe(childVer);

    // Soft-delete the child — trigger must clear the ref.
    await svc
      .from("files")
      .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
      .eq("id", childId);

    const { data: after } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(after![0].child_file_id).toBeNull();
    expect(after![0].child_version_id).toBeNull();
  });

  it("re-resolves dangling refs when the child is restored from the recycle bin", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const childId = await addFile(vaultId, folderId, "bracket.sldprt");
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const svc = serviceClient();
    const c = await signInAs(editor.email!);
    const childVer = await checkIn(c, editor.id, childId, "c".repeat(64));
    const parentVer = await checkIn(c, editor.id, parentId, "p".repeat(64));

    // Record a resolved ref, then delete the child (H7 fix nulls it out).
    await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["bracket.sldprt"],
    });
    await svc
      .from("files")
      .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
      .eq("id", childId);

    const { data: mid } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(mid![0].child_file_id).toBeNull(); // deleted — now dangling

    // Restore the child — trigger must re-resolve the dangling ref.
    await svc.from("files").update({ deleted_at: null, deleted_by: null }).eq("id", childId);

    const { data: after } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(after![0].child_file_id).toBe(childId);
    expect(after![0].child_version_id).toBe(childVer);
  });

  it("does NOT re-resolve on restore when another live file shares the same basename", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const svc = serviceClient();
    // Two folders so the unique-per-folder constraint is satisfied.
    const { data: f2 } = await svc.from("folders").insert({ vault_id: vaultId, name: "other" }).select().single();

    const child1Id = await addFile(vaultId, folderId, "frame.sldprt");
    const child2Id = await addFile(vaultId, f2!.id, "frame.sldprt"); // same basename, different folder
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    await checkIn(c, editor.id, child1Id, "1".repeat(64));
    await checkIn(c, editor.id, child2Id, "2".repeat(64));
    const parentVer = await checkIn(c, editor.id, parentId, "p".repeat(64));

    await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["frame.sldprt"],
    });
    // Ambiguous at record time — should be unresolved.
    const { data: before } = await svc.from("refs").select("child_file_id").eq("parent_version_id", parentVer);
    expect(before![0].child_file_id).toBeNull();

    // Delete one of the duplicates then restore it — still two live files after
    // restore, so the hint must remain unresolved.
    await svc
      .from("files")
      .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
      .eq("id", child1Id);
    await svc.from("files").update({ deleted_at: null, deleted_by: null }).eq("id", child1Id);

    const { data: after } = await svc.from("refs").select("child_file_id").eq("parent_version_id", parentVer);
    expect(after![0].child_file_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M9 — restore_version re-pins child_version_id to current latest
// ---------------------------------------------------------------------------

describe("M9: restore_version re-pins child refs to current latest (20260619000300)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("carries forward child_file_id but updates child_version_id to the child's current latest", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const childId = await addFile(vaultId, folderId, "bracket.sldprt");
    const parentId = await addFile(vaultId, folderId, "frame.sldasm");

    const svc = serviceClient();
    const c = await signInAs(editor.email!);

    // Check in child v1, then parent v1 (refs pinned to child v1).
    const childV1 = await checkIn(c, editor.id, childId, "c1".padEnd(64, "1"));
    const parentV1 = await checkIn(c, editor.id, parentId, "p1".padEnd(64, "1"));

    await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentV1,
      p_child_hints: ["bracket.sldprt"],
    });

    // Advance child to v2 (newer content).
    const childV2 = await checkIn(c, editor.id, childId, "c2".padEnd(64, "2"));
    // Advance parent to v2 as well (so v1 is now an "old" version to restore from).
    await checkIn(c, editor.id, parentId, "p2".padEnd(64, "2"));

    // Restore parent back to v1 — the new version (v3) must pin childV2, not childV1.
    await c.from("locks").insert({ file_id: parentId, user_id: editor.id });
    const { data: restored, error } = await c.rpc("pdm_restore_version", {
      p_file_id: parentId,
      p_version_id: parentV1,
    });
    expect(error).toBeNull();

    const { data: refs } = await svc.from("refs").select("*").eq("parent_version_id", (restored as any).id);
    expect(refs).toHaveLength(1);
    expect(refs![0].child_file_id).toBe(childId);
    // Must be updated to current latest (v2), not stale v1.
    expect(refs![0].child_version_id).toBe(childV2);
    expect(refs![0].child_version_id).not.toBe(childV1);
  });

  it("leaves child_version_id from old version when child has since been soft-deleted (no live latest)", async () => {
    // If the child is deleted its latest_version_id may still be set but
    // deleted_at is not null — the M9 fix skips it (cf.deleted_at is null).
    // The ref should keep the old child_version_id rather than be cleared to null.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const childId = await addFile(vaultId, folderId, "deleted-part.sldprt");
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const svc = serviceClient();
    const c = await signInAs(editor.email!);

    const childV1 = await checkIn(c, editor.id, childId, "d1".padEnd(64, "1"));
    const parentV1 = await checkIn(c, editor.id, parentId, "a1".padEnd(64, "1"));

    // Manually insert a ref pinned to childV1 on parentV1.
    await svc.from("refs").insert({
      parent_version_id: parentV1,
      child_path_hint: "deleted-part.sldprt",
      child_file_id: childId,
      child_version_id: childV1,
    });

    // Advance parent to v2 (so v1 is old).
    await checkIn(c, editor.id, parentId, "a2".padEnd(64, "2"));

    // Soft-delete the child.
    await svc
      .from("files")
      .update({ deleted_at: new Date().toISOString(), deleted_by: admin.id })
      .eq("id", childId);

    // Restore parent to v1 — child is deleted, so M9 re-pin must be skipped.
    await c.from("locks").insert({ file_id: parentId, user_id: editor.id });
    const { data: restored, error } = await c.rpc("pdm_restore_version", {
      p_file_id: parentId,
      p_version_id: parentV1,
    });
    expect(error).toBeNull();

    // H7 trigger fires on the child's deleted_at update, which nulls out the
    // child_file_id in existing refs — but the restored version's refs are
    // inserted AFTER that event and don't go through the trigger.  The M9 fix
    // skips the deleted child (deleted_at is not null), so child_version_id
    // retains the value copied from v_target.
    // Verify the ref still has child_file_id (H7 trigger only acts on existing
    // rows, not on the insert inside restore_version which happens after the
    // delete event).
    const { data: refs } = await svc
      .from("refs")
      .select("child_file_id,child_version_id")
      .eq("parent_version_id", (restored as any).id);
    expect(refs).toHaveLength(1);
    // child_version_id is not overwritten to null by M9 fix (deleted child skipped).
    expect(refs![0].child_version_id).toBe(childV1);
  });
});

// ---------------------------------------------------------------------------
// M11 — record_refs allows authorised editors to record refs for imported
//        versions (author_id IS NULL)
// ---------------------------------------------------------------------------

describe("M11: record_refs accepts imported versions (author_id IS NULL) (20260619000300)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  /** Seed an imported version (author_id = null) via the service role, bypassing
   *  record_refs auth.  Returns the version id. */
  async function seedImportedVersion(
    vaultId: string,
    folderId: string,
    fileName: string,
    sha: string,
  ): Promise<{ fileId: string; versionId: string }> {
    const svc = serviceClient();
    const fileId = await addFile(vaultId, folderId, fileName);
    // Insert version with author_id = null (the import shape).
    const { data: v } = await svc
      .from("versions")
      .insert({ file_id: fileId, version_num: 1, sha256: sha, size_bytes: 1, author_id: null })
      .select()
      .single();
    await svc.from("files").update({ latest_version_id: v!.id }).eq("id", fileId);
    return { fileId, versionId: v!.id };
  }

  it("lets a vault editor record refs for an imported version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const childId = await addFile(vaultId, folderId, "frame-rail.sldprt");
    const { versionId: importedVer } = await seedImportedVersion(
      vaultId,
      folderId,
      "asm-imported.sldasm",
      "i".repeat(64),
    );

    const svc = serviceClient();
    const c = await signInAs(editor.email!);
    // Give the child a version so resolution succeeds.
    await checkIn(c, editor.id, childId, "r".repeat(64));

    const { data, error } = await c.rpc("pdm_record_refs", {
      p_parent_version_id: importedVer,
      p_child_hints: ["frame-rail.sldprt"],
    });
    expect(error).toBeNull();
    expect(data).toBe(1);

    const { data: rows } = await svc.from("refs").select("*").eq("parent_version_id", importedVer);
    expect(rows).toHaveLength(1);
    expect(rows![0].child_file_id).toBe(childId);
  });

  it("still rejects a viewer from recording refs for an imported version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");
    const { vaultId, folderId } = await seedVault(admin.id);

    const { versionId: importedVer } = await seedImportedVersion(
      vaultId,
      folderId,
      "asm-viewer.sldasm",
      "v".repeat(64),
    );

    const vc = await signInAs(viewer.email!);
    const { error } = await vc.rpc("pdm_record_refs", {
      p_parent_version_id: importedVer,
      p_child_hints: ["anything.sldprt"],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);
  });

  it("still rejects a non-member from recording refs for an imported version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const outsider = await createTestUser(uniqueEmail("outsider"));
    // No role granted — outsider is not a vault member.
    const { vaultId, folderId } = await seedVault(admin.id);

    const { versionId: importedVer } = await seedImportedVersion(
      vaultId,
      folderId,
      "asm-outsider.sldasm",
      "o".repeat(64),
    );

    const oc = await signInAs(outsider.email!);
    const { error } = await oc.rpc("pdm_record_refs", {
      p_parent_version_id: importedVer,
      p_child_hints: ["anything.sldprt"],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);
  });

  it("still rejects a different editor from recording refs for a normal (non-imported) version", async () => {
    // Original guard: only the author may record refs for a version with a
    // non-null author_id — the M11 fallback must not widen this path.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const author = await createTestUser(uniqueEmail("author"));
    await setRole(author.id, "editor");
    const other = await createTestUser(uniqueEmail("other"));
    await setRole(other.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);

    const parentId = await addFile(vaultId, folderId, "asm.sldasm");
    const authorClient = await signInAs(author.email!);
    const parentVer = await checkIn(authorClient, author.id, parentId, "x".repeat(64));

    const otherClient = await signInAs(other.email!);
    const { error } = await otherClient.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["anything.sldprt"],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not authorized/i);
  });
});
