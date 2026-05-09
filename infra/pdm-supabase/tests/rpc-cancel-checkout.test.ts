import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

async function seedFile(adminId: string): Promise<string> {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults").insert({ name: `v-${Date.now()}`, created_by: adminId }).select().single();
  const { data: f } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
  const { data: file } = await svc.from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
  return file!.id;
}

describe("pdm.cancel_checkout()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("releases the caller's own lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });

    const { error } = await c.rpc("pdm_cancel_checkout", { p_file_id: fileId });
    expect(error).toBeNull();

    const svc = serviceClient();
    const { data: locks } = await svc.from("locks").select("released_at, force_released_by").eq("file_id", fileId);
    expect(locks!.every((l) => l.released_at !== null)).toBe(true);
    expect(locks!.every((l) => l.force_released_by === null)).toBe(true);
  });

  it("rejects when the caller has no active lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    const { error } = await c.rpc("pdm_cancel_checkout", { p_file_id: fileId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/no active lock/i);
  });
});
