import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedVaultAndFile(adminId: string): Promise<{ fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc
    .from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc
    .from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return { fileId: file!.id };
}

// Note (2026-05-25 audit fix): the previous versions of these tests asserted
// that an editor *holding the lock* could directly INSERT into pdm.versions.
// That contradicted migration 20260511000300_pdm_versions_revoke_dml.sql,
// which explicitly REVOKEd INSERT/UPDATE/DELETE on pdm.versions from
// `authenticated` and dropped the `versions_insert_lockholder` policy. The
// safe path is forced through pdm.check_in (the SECURITY DEFINER RPC),
// which owns numbering, parent linkage, and audit log writes.
//
// These tests now assert the *current* security posture:
//   (1) direct INSERT/UPDATE/DELETE on pdm.versions is denied for any
//       authenticated role — even an editor holding the lock — so the only
//       legitimate write path is pdm_check_in().
//   (2) SELECT remains open per the versions_read policy (single-team app).
describe("versions RLS — direct DML is fully revoked", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor WITHOUT a lock cannot direct-INSERT a version row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
    });
    expect(error?.code).toBe("42501");
  });

  it("editor HOLDING a lock STILL cannot direct-INSERT a version row (must use pdm_check_in)", async () => {
    // This is the regression guard the 2026-05-25 audit added. Migration
    // 20260511000300 closed the H1 hole where a lockholder could craft
    // arbitrary version rows (fork history, lie about parentage). If a future
    // migration accidentally re-grants INSERT on pdm.versions to authenticated,
    // this test will catch it immediately.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    // Acquire the lock first — this used to be the bypass path.
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 99,         // forge an out-of-order version number
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
      parent_version_id: null, // lie about parentage
    });
    expect(error?.code).toBe("42501");
  });

  it("admin cannot direct-INSERT either (no admin escape hatch for versions)", async () => {
    // Admins are also routed through pdm_check_in. The revoke is on the
    // grant, not on a per-role policy, so even is_admin() editors must use
    // the RPC.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(admin.email!);
    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "b".repeat(64),
      size_bytes: 1,
      author_id: admin.id,
    });
    expect(error?.code).toBe("42501");
  });

  it("editor cannot direct-UPDATE a version row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    // Seed a version via the privileged service role.
    const svc = serviceClient();
    const { data: ver } = await svc.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "c".repeat(64),
      size_bytes: 1,
      author_id: admin.id,
    }).select().single();

    const c = await signInAs(editor.email!);
    const { error } = await c
      .from("versions")
      .update({ comment: "tampered" })
      .eq("id", ver!.id);
    expect(error?.code).toBe("42501");
  });

  it("editor cannot direct-DELETE a version row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const svc = serviceClient();
    const { data: ver } = await svc.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "d".repeat(64),
      size_bytes: 1,
      author_id: admin.id,
    }).select().single();

    const c = await signInAs(editor.email!);
    const { error } = await c.from("versions").delete().eq("id", ver!.id);
    expect(error?.code).toBe("42501");
  });

  it("any role can SELECT versions (single-team read posture)", async () => {
    // Sanity check that the revoke didn't accidentally tighten reads.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");
    const { fileId } = await seedVaultAndFile(admin.id);

    const svc = serviceClient();
    await svc.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "e".repeat(64),
      size_bytes: 1,
      author_id: admin.id,
    });

    const c = await signInAs(viewer.email!);
    const { data, error } = await c.from("versions").select("*").eq("file_id", fileId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
