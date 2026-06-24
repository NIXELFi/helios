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

describe("audit log — structural + role events", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("audits file create / rename / move / delete", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor")); await setRole(editor.id, "editor");
    const svc = serviceClient();
    const { data: v } = await svc.from("vaults").insert({ name: vaultName(), created_by: admin.id }).select().single();
    const { data: f1 } = await svc.from("folders").insert({ vault_id: v!.id, name: "parts" }).select().single();
    const { data: f2 } = await svc.from("folders").insert({ vault_id: v!.id, name: "asm" }).select().single();

    // Create as editor (RLS allows editor inserts) → file_create with user_id = editor.
    const c = await signInAs(editor.email!);
    const { data: file, error: ce } = await c
      .from("files").insert({ vault_id: v!.id, folder_id: f1!.id, name: "a.sldprt" }).select().single();
    expect(ce).toBeNull();
    // Rename / move / delete via service (files update/delete are admin-only in RLS).
    await svc.from("files").update({ name: "b.sldprt" }).eq("id", file!.id);
    await svc.from("files").update({ folder_id: f2!.id }).eq("id", file!.id);
    await svc.from("files").delete().eq("id", file!.id);

    const { data: rows } = await svc
      .from("audit_log").select("action,user_id,payload").eq("target_id", file!.id).order("ts", { ascending: true });
    const actions = rows!.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["file_create", "file_rename", "file_move", "file_delete"]));
    expect(rows!.find((r) => r.action === "file_create")!.user_id).toBe(editor.id);
    expect(rows!.find((r) => r.action === "file_rename")!.payload).toMatchObject({ old_name: "a.sldprt", new_name: "b.sldprt" });
  });

  it("audits folder create / delete", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const svc = serviceClient();
    const { data: v } = await svc.from("vaults").insert({ name: vaultName(), created_by: admin.id }).select().single();
    const { data: folder } = await svc.from("folders").insert({ vault_id: v!.id, name: "chassis" }).select().single();
    await svc.from("folders").delete().eq("id", folder!.id);

    const { data: rows } = await svc.from("audit_log").select("action").eq("target_id", folder!.id);
    expect(rows!.map((r) => r.action)).toEqual(expect.arrayContaining(["folder_create", "folder_delete"]));
  });

  it("audits a role grant", async () => {
    const admin = await createTestUser(uniqueEmail("admin")); await setRole(admin.id, "admin");
    const u = await createTestUser(uniqueEmail("u")); await setRole(u.id, "editor");
    const svc = serviceClient();
    const { data: rows } = await svc
      .from("audit_log").select("action,payload").eq("target_id", u.id).eq("action", "role_grant");
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    // A new signup is auto-provisioned a baseline 'viewer' role (audited as its own
    // role_grant), then this test grants 'editor' — so there are two role_grant rows
    // for the same target with no guaranteed query order. Assert the editor grant was
    // audited rather than assuming it is row [0] (which made this test flaky).
    expect(rows!.some((r) => (r.payload as { role?: string }).role === "editor")).toBe(true);
  });
});
