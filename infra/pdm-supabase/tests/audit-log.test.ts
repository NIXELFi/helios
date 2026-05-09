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

describe("audit log triggers", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("acquiring a lock writes a check_out audit row", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    const { data: lock } = await c.from("locks").insert({ file_id: fileId, user_id: editor.id }).select().single();

    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log")
      .select("action, target_type, target_id, user_id")
      .eq("target_id", lock!.id);
    expect(rows!.some((r) => r.action === "check_out")).toBe(true);
    expect(rows!.find((r) => r.action === "check_out")!.user_id).toBe(editor.id);
  });

  it("check_in writes a check_in audit row referencing the version", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const c = await signInAs(editor.email!);
    await c.from("locks").insert({ file_id: fileId, user_id: editor.id });
    const { data: ver } = await c.rpc("pdm_check_in", {
      p_file_id: fileId, p_sha256: "a".repeat(64), p_size: 1, p_comment: "init",
    });

    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log")
      .select("action, target_type, target_id")
      .eq("target_id", ver.id);
    expect(rows!.some((r) => r.action === "check_in" && r.target_type === "version")).toBe(true);
  });

  it("force_unlock writes an audit row including the reason", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const fileId = await seedFile(admin.id);

    const eClient = await signInAs(editor.email!);
    const { data: lock } = await eClient.from("locks").insert({ file_id: fileId, user_id: editor.id }).select().single();
    const aClient = await signInAs(admin.email!);
    await aClient.rpc("pdm_force_unlock", { p_lock_id: lock!.id, p_reason: "left for the day" });

    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log")
      .select("action, payload, user_id")
      .eq("target_id", lock!.id)
      .eq("action", "force_unlock");
    expect(rows!.length).toBe(1);
    expect(rows![0].payload).toMatchObject({ reason: "left for the day" });
    expect(rows![0].user_id).toBe(admin.id);
  });
});
