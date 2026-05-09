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

describe("versions RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor without lock cannot insert a version", async () => {
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

  it("editor holding the lock can insert a version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
    });
    expect(error).toBeNull();
  });

  it("editor whose lock is released cannot insert a version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data: lock } = await c
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    await c.from("locks").update({ released_at: new Date().toISOString() }).eq("id", lock!.id);

    const { error } = await c.from("versions").insert({
      file_id: fileId,
      version_num: 1,
      sha256: "a".repeat(64),
      size_bytes: 1,
      author_id: editor.id,
    });
    expect(error?.code).toBe("42501");
  });
});
