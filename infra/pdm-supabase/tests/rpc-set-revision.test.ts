import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

const vaultName = () => `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedFile(adminId: string, name = "frame.sldprt"): Promise<{ vaultId: string; fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: vaultName(), created_by: adminId }).select().single();
  const { data: folder } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc.from("files").insert({ vault_id: v!.id, folder_id: folder!.id, name }).select().single();
  return { vaultId: v!.id, fileId: file!.id };
}

async function checkIn(client: any, editorId: string, fileId: string, sha: string): Promise<string> {
  await client.from("locks").insert({ file_id: fileId, user_id: editorId });
  const { data, error } = await client.rpc("pdm_check_in", { p_file_id: fileId, p_sha256: sha, p_size: 1, p_comment: null });
  if (error) throw new Error(error.message);
  return data.id;
}

describe("pdm.set_revision()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("auto-assigns revision 1 on the first set, stamped on the latest version", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const { fileId } = await seedFile(admin.id);
    const c = await signInAs(editor.email!);
    const v1 = await checkIn(c, editor.id, fileId, "a".repeat(64));

    const { data, error } = await c.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: null });
    expect(error).toBeNull();
    expect(data.id).toBe(v1);
    expect(data.revision).toBe(1);
  });

  it("auto-increments across versions (rev 1 then rev 2 on the new latest)", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const { fileId } = await seedFile(admin.id);
    const c = await signInAs(editor.email!);
    await checkIn(c, editor.id, fileId, "a".repeat(64));
    await c.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: null }); // rev 1
    const v2 = await checkIn(c, editor.id, fileId, "b".repeat(64));
    const { data } = await c.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: null });
    expect(data.id).toBe(v2);
    expect(data.revision).toBe(2);
  });

  it("uses an explicit revision value", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const { fileId } = await seedFile(admin.id);
    const c = await signInAs(editor.email!);
    await checkIn(c, editor.id, fileId, "a".repeat(64));
    const { data } = await c.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: 5 });
    expect(data.revision).toBe(5);
  });

  it("writes a set_revision audit row", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const { fileId } = await seedFile(admin.id);
    const c = await signInAs(editor.email!);
    const v1 = await checkIn(c, editor.id, fileId, "a".repeat(64));
    await c.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: null });

    const svc = serviceClient();
    const { data: rows } = await svc.from("audit_log").select("action,payload").eq("target_id", v1).eq("action", "set_revision");
    expect(rows!.length).toBe(1);
    expect(rows![0].payload).toMatchObject({ revision: 1 });
  });

  it("rejects a non-editor (viewer)", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer")); await setRole(viewer.id, "viewer");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const { fileId } = await seedFile(admin.id);
    const ec = await signInAs(editor.email!);
    await checkIn(ec, editor.id, fileId, "a".repeat(64));

    const vc = await signInAs(viewer.email!);
    const { error } = await vc.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: null });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/editor role required/i);
  });

  it("rejects setting a revision on a file with no version", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const { fileId } = await seedFile(admin.id); // seeded file, no version checked in
    const c = await signInAs(editor.email!);
    const { error } = await c.rpc("pdm_set_revision", { p_file_id: fileId, p_revision: null });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/no version/i);
  });
});
