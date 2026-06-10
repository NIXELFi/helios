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

async function addFile(vaultId: string, folderId: string | null, name: string): Promise<string> {
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

describe("refs re-resolution on late child creation (20260610200000)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("resolves a dangling hint when the child file is created AFTER the parent's check-in", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const parentVer = await checkIn(c, editor.id, parentId, "a".repeat(64));
    // Parent references a part that does NOT exist in the vault yet.
    const { error: refErr } = await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["..\\sub\\late-part.sldprt"],
    });
    expect(refErr).toBeNull();

    const svc = serviceClient();
    const { data: before } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(before![0].child_file_id).toBeNull(); // unresolved, as today

    // The part arrives later (auto-vaulting / teammate adds it) + first check-in.
    const childId = await addFile(vaultId, folderId, "late-part.sldprt");
    const childVer = await checkIn(c, editor.id, childId, "b".repeat(64));

    const { data: after } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(after![0].child_file_id).toBe(childId);
    expect(after![0].child_version_id).toBe(childVer); // pinned when the first version landed
  });

  it("does NOT resolve when the basename is already ambiguous in the vault", async () => {
    // Matching record_refs semantics: resolution happens when a basename is
    // UNIQUE at that moment (and, like record_refs, later ambiguity never
    // unresolves an existing link). The guard matters when ambiguity already
    // exists: a third same-named file must not grab the dangling hint.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const svc = serviceClient();
    const { data: f2 } = await svc.from("folders").insert({ vault_id: vaultId, name: "other" }).select().single();
    const { data: f3 } = await svc.from("folders").insert({ vault_id: vaultId, name: "third" }).select().single();
    // Ambiguity exists BEFORE the parent records its hint…
    await addFile(vaultId, folderId, "dupe.sldprt");
    await addFile(vaultId, f2!.id, "dupe.sldprt");
    const parentId = await addFile(vaultId, folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const parentVer = await checkIn(c, editor.id, parentId, "a".repeat(64));
    await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["..\\dupe.sldprt"],
    });
    const { data: before } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(before![0].child_file_id).toBeNull(); // ambiguous at record time

    // …and a THIRD same-named file arriving later must not claim the hint.
    await addFile(vaultId, f3!.id, "dupe.sldprt");
    const { data: after } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(after![0].child_file_id).toBeNull();
  });

  it("does not cross vault boundaries when re-resolving", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const a = await seedVault(admin.id);
    const b = await seedVault(admin.id);
    const parentId = await addFile(a.vaultId, a.folderId, "asm.sldasm");

    const c = await signInAs(editor.email!);
    const parentVer = await checkIn(c, editor.id, parentId, "a".repeat(64));
    await c.rpc("pdm_record_refs", {
      p_parent_version_id: parentVer,
      p_child_hints: ["wheel.sldprt"],
    });

    // Same basename lands in a DIFFERENT vault — must not resolve.
    await addFile(b.vaultId, b.folderId, "wheel.sldprt");

    const svc = serviceClient();
    const { data: refs } = await svc.from("refs").select("*").eq("parent_version_id", parentVer);
    expect(refs![0].child_file_id).toBeNull();
  });
});

describe("pdm.restore_version() (20260610200000)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  async function seedFileWithTwoVersions() {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { vaultId, folderId } = await seedVault(admin.id);
    const fileId = await addFile(vaultId, folderId, "frame.sldprt");
    const c = await signInAs(editor.email!);
    const v1 = await checkIn(c, editor.id, fileId, "1".repeat(64));
    const v2 = await checkIn(c, editor.id, fileId, "2".repeat(64));
    return { admin, editor, vaultId, fileId, v1, v2, c };
  }

  it("creates the next version with the restored content sha; comment credits the source; lock releases", async () => {
    const { editor, fileId, v1, c } = await seedFileWithTwoVersions();
    const svc = serviceClient();

    // Restore requires a fresh checkout (it IS a check-in).
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const { data: restored, error } = await c.rpc("pdm_restore_version", {
      p_file_id: fileId, p_version_id: v1,
    });
    expect(error).toBeNull();
    expect(restored.version_num).toBe(3);
    expect(restored.sha256).toBe("1".repeat(64));
    expect(restored.comment).toMatch(/Restored from v1/);

    const { data: f } = await svc.from("files").select("latest_version_id").eq("id", fileId).single();
    expect(f!.latest_version_id).toBe(restored.id);

    const { data: locks } = await svc.from("locks").select("released_at").eq("file_id", fileId).order("acquired_at", { ascending: false }).limit(1);
    expect(locks![0].released_at).not.toBeNull();

    const { data: audit } = await svc.from("audit_log").select("action").eq("target_id", restored.id);
    expect(audit!.map((r) => r.action)).toContain("restore_version");
  });

  it("rejects without an active lock held by the caller", async () => {
    const { fileId, v1, c } = await seedFileWithTwoVersions();
    const { error } = await c.rpc("pdm_restore_version", {
      p_file_id: fileId, p_version_id: v1,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/check the file out/i);
  });

  it("rejects a viewer even when they somehow hold a lock", async () => {
    const { fileId, v1 } = await seedFileWithTwoVersions();
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");
    const svc = serviceClient();
    await svc.from("locks").insert({ file_id: fileId, user_id: viewer.id }); // seeded via service role
    const vc = await signInAs(viewer.email!);
    const { error } = await vc.rpc("pdm_restore_version", {
      p_file_id: fileId, p_version_id: v1,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/editor role required/i);
  });

  it("restoring the already-latest content releases the lock without duplicating history", async () => {
    const { editor, fileId, v2, c } = await seedFileWithTwoVersions();
    const svc = serviceClient();
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const { data: restored, error } = await c.rpc("pdm_restore_version", {
      p_file_id: fileId, p_version_id: v2,
    });
    expect(error).toBeNull();
    expect(restored.id).toBe(v2); // no new row
    const { data: count } = await svc.from("versions").select("id").eq("file_id", fileId);
    expect(count!).toHaveLength(2);
  });

  it("rejects a version id that belongs to a different file", async () => {
    const { editor, vaultId, fileId, c } = await seedFileWithTwoVersions();
    const otherId = await addFile(vaultId, null, "other.sldprt");
    const otherVer = await checkIn(c, editor.id, otherId, "9".repeat(64));
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const { error } = await c.rpc("pdm_restore_version", {
      p_file_id: fileId, p_version_id: otherVer,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not found on file/i);
  });

  it("carries the restored version's refs forward to the new version", async () => {
    const { editor, vaultId, fileId, v1, c } = await seedFileWithTwoVersions();
    const svc = serviceClient();
    // Give v1 a resolved ref (recorded by its author at the time).
    const childId = await addFile(vaultId, null, "bracket.sldprt");
    await svc.from("refs").insert({
      parent_version_id: v1, child_path_hint: "bracket.sldprt", child_file_id: childId,
    });

    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const { data: restored, error } = await c.rpc("pdm_restore_version", {
      p_file_id: fileId, p_version_id: v1,
    });
    expect(error).toBeNull();

    const { data: refs } = await svc.from("refs").select("*").eq("parent_version_id", restored.id);
    expect(refs).toHaveLength(1);
    expect(refs![0].child_file_id).toBe(childId);
  });
});
