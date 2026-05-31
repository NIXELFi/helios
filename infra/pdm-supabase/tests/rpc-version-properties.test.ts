import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser, resetAuthUsers, serviceClient, setRole, signInAs, uniqueEmail,
} from "./setup.js";

const vaultName = () => `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedFileWithVersion(adminId: string, editorClient: any, editorId: string) {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: vaultName(), created_by: adminId }).select().single();
  const { data: folder } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc.from("files").insert({ vault_id: v!.id, folder_id: folder!.id, name: "p.sldprt" }).select().single();
  await editorClient.from("locks").insert({ file_id: file!.id, user_id: editorId });
  const { data: ver } = await editorClient.rpc("pdm_check_in", { p_file_id: file!.id, p_sha256: "a".repeat(64), p_size: 1, p_comment: null });
  return { vaultId: v!.id, fileId: file!.id, versionId: ver.id };
}

describe("pdm.set_version_properties()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("an editor stores properties on a version; they read back", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const c = await signInAs(editor.email!);
    const { versionId } = await seedFileWithVersion(admin.id, c, editor.id);

    const props = [{ name: "PartNo", value: "ABC-1" }, { name: "Material", value: "7075-T6" }];
    const { error } = await c.rpc("pdm_set_version_properties", { p_version_id: versionId, p_properties: props });
    expect(error).toBeNull();

    const svc = serviceClient();
    const { data: rows } = await svc.from("versions").select("properties").eq("id", versionId);
    expect(rows![0].properties).toEqual(props);
  });

  it("rejects a viewer", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const viewer = await createTestUser(uniqueEmail("viewer")); await setRole(viewer.id, "viewer");
    const c = await signInAs(editor.email!);
    const { versionId } = await seedFileWithVersion(admin.id, c, editor.id);

    const vc = await signInAs(viewer.email!);
    const { error } = await vc.rpc("pdm_set_version_properties", { p_version_id: versionId, p_properties: [] });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/editor role required/i);
  });
});
