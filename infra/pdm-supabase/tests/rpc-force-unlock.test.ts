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

describe("pdm.force_unlock()", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("admin can force-unlock another user's lock; sets force_released_by", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const eClient = await signInAs(editor.email!);
    const { data: lock } = await eClient.from("locks").insert({ file_id: fileId, user_id: editor.id }).select().single();

    const aClient = await signInAs(admin.email!);
    const { error } = await aClient.rpc("pdm_force_unlock", { p_lock_id: lock!.id, p_reason: "left for the day" });
    expect(error).toBeNull();

    const svc = serviceClient();
    const { data: locks } = await svc.from("locks").select("released_at, force_released_by").eq("id", lock!.id).single();
    expect(locks!.released_at).not.toBeNull();
    expect(locks!.force_released_by).toBe(admin.id);
  });

  it("non-admin cannot force-unlock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await createTestUser(uniqueEmail("a"));
    await setRole(a.id, "editor");
    const b = await createTestUser(uniqueEmail("b"));
    await setRole(b.id, "editor");
    const fileId = await seedFile(admin.id);

    const aClient = await signInAs(a.email!);
    const { data: lock } = await aClient.from("locks").insert({ file_id: fileId, user_id: a.id }).select().single();

    const bClient = await signInAs(b.email!);
    const { error } = await bClient.rpc("pdm_force_unlock", { p_lock_id: lock!.id, p_reason: "trying" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/admin/i);
  });
});
