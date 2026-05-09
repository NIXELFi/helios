import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

describe("vaults / folders / files RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("editor can read vaults but not insert", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    // Admin creates a vault via service client (bypassing RLS) — simulating a prior admin op.
    const svc = serviceClient();
    const { data: vault, error: vErr } = await svc
      .from("vaults")
      .insert({ name: "test-vault", created_by: admin.id })
      .select()
      .single();
    expect(vErr).toBeNull();

    const eClient = await signInAs(editor.email!);
    const { data: rows, error: readErr } = await eClient.from("vaults").select("*");
    expect(readErr).toBeNull();
    expect(rows?.length).toBe(1);

    const { error: insErr } = await eClient.from("vaults").insert({
      name: "editor-vault",
      created_by: editor.id,
    });
    expect(insErr).not.toBeNull();
    expect(insErr?.code).toBe("42501");
  });

  it("admin can create vaults, folders, and files", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const c = await signInAs(admin.email!);

    const { data: vault, error: vErr } = await c
      .from("vaults")
      .insert({ name: "vault-1", created_by: admin.id })
      .select()
      .single();
    expect(vErr).toBeNull();

    const { data: folder, error: fErr } = await c
      .from("folders")
      .insert({ vault_id: vault!.id, name: "parts" })
      .select()
      .single();
    expect(fErr).toBeNull();

    const { error: fileErr } = await c
      .from("files")
      .insert({ vault_id: vault!.id, folder_id: folder!.id, name: "frame.sldprt" });
    expect(fileErr).toBeNull();
  });

  it("editor CAN insert folders and files; admin-only enforcement remains for update/delete", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const svc = serviceClient();
    const { data: vault } = await svc
      .from("vaults")
      .insert({ name: "vault-2", created_by: admin.id })
      .select()
      .single();

    const eClient = await signInAs(editor.email!);

    // Editors can now insert folders (designer-driven add workflow).
    const { data: folder, error: folderErr } = await eClient
      .from("folders")
      .insert({ vault_id: vault!.id, name: "editor-created" })
      .select()
      .single();
    expect(folderErr).toBeNull();
    expect(folder).not.toBeNull();

    // Editors can now insert files.
    const { error: fileErr } = await eClient
      .from("files")
      .insert({ vault_id: vault!.id, folder_id: folder!.id, name: "editor-created.sldprt" });
    expect(fileErr).toBeNull();

    // Update on folders remains admin-only. Postgres RLS uses the USING clause to
    // filter which rows are visible; if the editor cannot pass the USING predicate,
    // the update matches 0 rows (no DB error) rather than throwing 42501. Verify
    // the row was NOT renamed.
    const { error: updateErr } = await eClient
      .from("folders")
      .update({ name: "renamed" })
      .eq("id", folder!.id);
    expect(updateErr).toBeNull(); // silently affects 0 rows

    // Confirm the name is unchanged (admin can still read the original name).
    const { data: check } = await svc.from("folders").select("name").eq("id", folder!.id).single();
    expect(check?.name).toBe("editor-created");
  });
});
