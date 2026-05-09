import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";
import type { SupabaseClient } from "@supabase/supabase-js";

async function seedVaultAndFile(adminId: string): Promise<{ fileId: string }> {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: `v-${Date.now()}`, created_by: adminId })
    .select()
    .single();
  const { data: f } = await svc
    .from("folders")
    .insert({ vault_id: v!.id, name: "parts" })
    .select()
    .single();
  const { data: file } = await svc
    .from("files")
    .insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" })
    .select()
    .single();
  return { fileId: file!.id };
}

describe("locks RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor can acquire a lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data, error } = await c
      .from("locks")
      .insert({ file_id: fileId, user_id: editor.id })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBe(editor.id);
  });

  it("viewer cannot acquire a lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");
    const { fileId } = await seedVaultAndFile(admin.id);

    const c = await signInAs(viewer.email!);
    const { error } = await c.from("locks").insert({ file_id: fileId, user_id: viewer.id });
    expect(error?.code).toBe("42501");
  });

  it("two editors cannot hold an active lock on the same file", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await createTestUser(uniqueEmail("a"));
    await setRole(a.id, "editor");
    const b = await createTestUser(uniqueEmail("b"));
    await setRole(b.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const aClient = await signInAs(a.email!);
    const { error: aErr } = await aClient.from("locks").insert({ file_id: fileId, user_id: a.id });
    expect(aErr).toBeNull();

    const bClient = await signInAs(b.email!);
    const { error: bErr } = await bClient.from("locks").insert({ file_id: fileId, user_id: b.id });
    expect(bErr).not.toBeNull();
    expect(bErr?.code).toBe("23505"); // unique_violation
  });

  it("editor can release their own lock by updating released_at", async () => {
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
    const { error } = await c
      .from("locks")
      .update({ released_at: new Date().toISOString() })
      .eq("id", lock!.id);
    expect(error).toBeNull();
  });

  it("editor cannot release another editor's lock", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await createTestUser(uniqueEmail("a"));
    await setRole(a.id, "editor");
    const b = await createTestUser(uniqueEmail("b"));
    await setRole(b.id, "editor");
    const { fileId } = await seedVaultAndFile(admin.id);

    const aClient = await signInAs(a.email!);
    const { data: lock } = await aClient
      .from("locks")
      .insert({ file_id: fileId, user_id: a.id })
      .select()
      .single();

    const bClient = await signInAs(b.email!);
    const { data, error } = await bClient
      .from("locks")
      .update({ released_at: new Date().toISOString() })
      .eq("id", lock!.id)
      .select();
    // RLS: update silently affects 0 rows when the using clause excludes the row.
    expect(error).toBeNull();
    expect(data?.length).toBe(0);
  });
});
