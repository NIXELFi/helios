// rls-audit-log-scoping.test.ts
//
// CI guard for M6: cross-vault audit_log read exposure.
//
// Policy under test (20260619000400_pdm_audit_log_vault_scoped_read.sql):
//
//   user_id = auth.uid()                     -- own rows
//   OR exists (                              -- GLOBAL admin/owner only
//       select 1 from pdm.user_roles
//       where user_id = auth.uid()
//         and role in ('owner','admin')
//         and vault_id is null               -- vault_id IS NULL = global grant
//     )
//
// WHY NOT pdm.is_admin(): pdm.is_admin() has no vault_id filter. After
// 20260531000000, a per-vault admin row (role='admin', vault_id=X) satisfies
// it, so any per-vault admin could read every vault's audit rows. The policy
// inlines a vault_id IS NULL guard instead. See migration header for full
// analysis.
//
// Each test seeds audit rows via the service role (bypasses RLS) so the
// SELECT policy is isolated. We do NOT rely on trigger-generated rows so
// the test is deterministic and independent of RPC internals.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  setVaultRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const vaultName = () => `audit-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Seed a vault (with a file inside) and return its id + file id. */
async function seedVault(creatorId: string) {
  const svc = serviceClient();
  const { data: v } = await svc
    .from("vaults")
    .insert({ name: vaultName(), created_by: creatorId })
    .select()
    .single();
  const { data: folder } = await svc
    .from("folders")
    .insert({ vault_id: v!.id, name: "chassis" })
    .select()
    .single();
  const { data: f } = await svc
    .from("files")
    .insert({
      vault_id: v!.id,
      folder_id: folder!.id,
      name: "frame.sldprt",
      created_by: creatorId,
      published_at: new Date().toISOString(),
    })
    .select()
    .single();
  return { vaultId: v!.id, fileId: f!.id };
}

/** Seed a synthetic audit row via the service client (bypasses RLS / triggers)
 *  so we can assert SELECT policy in isolation. Returns the inserted row id. */
async function seedAuditRow(actorId: string | null, targetId: string): Promise<number> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("audit_log")
    .insert({
      user_id: actorId,
      action: "test_action",
      target_type: "file",
      target_id: targetId,
      payload: { synthetic: true },
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedAuditRow failed: ${error.message}`);
  return (data as { id: number }).id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audit_log vault-scoped reads (20260619000400)", () => {
  beforeEach(async () => {
    await resetAuthUsers();
  });
  afterEach(async () => {
    await resetAuthUsers();
  });

  // -------------------------------------------------------------------------
  // M6 regression: per-vault ADMIN CANNOT read another vault's audit rows.
  //
  // This is the critical regression guard for the is_admin() vulnerability:
  // pdm.is_admin() has no vault_id filter, so a user with role='admin' and a
  // non-null vault_id still satisfies it. The fixed policy requires vault_id IS
  // NULL (global grant) for cross-vault read. A per-vault admin (vault_id set)
  // must NOT be able to see audit rows from a vault they have no role in.
  // -------------------------------------------------------------------------
  it("a per-vault admin (vault_id non-null) cannot read audit rows from a different vault", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");
    const perVaultAdmin = await createTestUser(uniqueEmail("pvadmin"));

    const a = await seedVault(owner.id);
    const b = await seedVault(owner.id);
    // Grant admin role ONLY in vault A (per-vault, vault_id non-null).
    // This user would satisfy the old pdm.is_admin() and could read vault B.
    await setVaultRole(perVaultAdmin.id, "admin", a.vaultId);

    // Seed an audit row for an action in vault B (not vault A).
    const rowIdB = await seedAuditRow(owner.id, b.fileId);

    const c = await signInAs(perVaultAdmin.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .eq("id", rowIdB);

    expect(error).toBeNull(); // RLS filters silently, not an error
    expect(data ?? []).toHaveLength(0); // vault-B row must be invisible to per-vault admin
  });

  // -------------------------------------------------------------------------
  // M6 regression: per-vault VIEWER CANNOT read another vault's audit rows
  // -------------------------------------------------------------------------
  it("a per-vault-only member cannot read audit rows from a vault they are NOT in", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member"));

    const a = await seedVault(admin.id);
    const b = await seedVault(admin.id);
    await setVaultRole(member.id, "viewer", a.vaultId); // member is in vault A only

    // Seed an audit row for a file in vault B (acted on by admin).
    const rowIdB = await seedAuditRow(admin.id, b.fileId);

    const c = await signInAs(member.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .eq("id", rowIdB);

    expect(error).toBeNull(); // RLS filters, not errors
    expect(data ?? []).toHaveLength(0); // vault-B row must be invisible
  });

  // -------------------------------------------------------------------------
  // A user sees their OWN audit rows regardless of vault membership
  // -------------------------------------------------------------------------
  it("a user can read their own audit rows (user_id = auth.uid())", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");

    const a = await seedVault(admin.id);

    // Seed an audit row where the actor IS the editor.
    const ownRowId = await seedAuditRow(editor.id, a.fileId);

    const c = await signInAs(editor.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .eq("id", ownRowId);

    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toContain(ownRowId);
  });

  // -------------------------------------------------------------------------
  // A GLOBAL admin (vault_id IS NULL) reads ALL audit rows (cross-vault).
  // Contrast with the per-vault-admin test above: setRole sets vault_id=null.
  // -------------------------------------------------------------------------
  it("a global admin (vault_id null) can read audit rows from any vault", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin"); // vault_id IS NULL — global grant
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor"); // global editor

    const a = await seedVault(admin.id);
    const b = await seedVault(admin.id);

    const rowA = await seedAuditRow(editor.id, a.fileId);
    const rowB = await seedAuditRow(editor.id, b.fileId);

    const c = await signInAs(admin.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .in("id", [rowA, rowB]);

    expect(error).toBeNull();
    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(rowA);
    expect(ids).toContain(rowB);
  });

  // -------------------------------------------------------------------------
  // A user with NO role at all reads nothing
  // -------------------------------------------------------------------------
  it("a user with no role reads no audit rows", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const stranger = await createTestUser(uniqueEmail("stranger")); // no role granted

    const a = await seedVault(admin.id);
    const rowId = await seedAuditRow(admin.id, a.fileId);

    const c = await signInAs(stranger.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .eq("id", rowId);

    expect(error).toBeNull(); // RLS silently filters
    expect(data ?? []).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A user cannot read another user's audit rows from the SAME vault
  // unless they are admin (conservative: non-admin sees only own rows)
  // -------------------------------------------------------------------------
  it("a non-admin member cannot read another member's audit rows", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer");

    const a = await seedVault(admin.id);

    // Audit row acted on by editor — NOT viewer.
    const rowId = await seedAuditRow(editor.id, a.fileId);

    const c = await signInAs(viewer.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .eq("id", rowId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0); // viewer cannot read editor's row
  });

  // -------------------------------------------------------------------------
  // Cross-vault: per-vault member sees OWN rows in THEIR vault (not blocked)
  // -------------------------------------------------------------------------
  it("a per-vault member's own audit rows are still visible to them", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member"));

    const a = await seedVault(admin.id);
    await setVaultRole(member.id, "viewer", a.vaultId);

    // Seed a row for member's own action in vault A.
    const ownRowId = await seedAuditRow(member.id, a.fileId);

    const c = await signInAs(member.email!);
    const { data, error } = await c
      .from("audit_log")
      .select("id")
      .eq("id", ownRowId);

    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toContain(ownRowId);
  });
});
