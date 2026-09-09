import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anonClient,
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  setVaultRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/**
 * 20260909100000 / 100100 / 100300 / 100400 — the load-audit cursor RPCs and
 * the read-policy rewrite.
 *
 * The RPCs are `security definer`: they check membership ONCE and then count
 * (or scan) without RLS, which is what removes ~half of all database time. The
 * risk that buys is a definer function leaking rows across a boundary RLS used
 * to enforce per row, so these tests pin the boundary:
 *   - vault_cursor answers for a vault you belong to and ZEROS for one you do
 *     not (a per-vault member must not learn another vault's size);
 *   - workspace_cursor returns NO ROW to a user who fails can_read_pm;
 *   - bridge_live_files returns EXACTLY the id set the same user gets from a
 *     plain RLS'd select — an equivalence check, not a spot check;
 *   - the rewritten files/versions/locks/folders policies keep a per-vault
 *     editor's visibility exactly where 20260610100000 put it.
 */

const vaultName = () => `v-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Seed a vault with a folder, a published file (+ version), an active lock,
 *  and — when `draftBy` is given — a second file left UNPUBLISHED by that user,
 *  which files_read hides from everyone else. */
async function seedVault(creatorId: string, opts: { lockHolderId?: string; draftBy?: string } = {}) {
  const svc = serviceClient();
  const { data: v } = await svc.from("vaults")
    .insert({ name: vaultName(), created_by: creatorId }).select().single();
  const { data: folder } = await svc.from("folders")
    .insert({ vault_id: v!.id, name: "chassis" }).select().single();
  const { data: f } = await svc.from("files")
    .insert({
      vault_id: v!.id, folder_id: folder!.id, name: "frame.sldprt",
      created_by: creatorId, published_at: new Date().toISOString(),
    }).select().single();
  const { data: ver } = await svc.from("versions")
    .insert({ file_id: f!.id, version_num: 1, sha256: "a".repeat(64), size_bytes: 10, author_id: creatorId })
    .select().single();
  if (opts.lockHolderId) {
    await svc.from("locks").insert({ file_id: f!.id, user_id: opts.lockHolderId });
  }
  let draftId: string | null = null;
  if (opts.draftBy) {
    const { data: d } = await svc.from("files")
      .insert({ vault_id: v!.id, folder_id: folder!.id, name: "draft.sldprt", created_by: opts.draftBy })
      .select().single();
    draftId = d!.id;
  }
  return { vaultId: v!.id, folderId: folder!.id, fileId: f!.id, versionId: ver!.id, draftId };
}

/** The four true counts for a vault, read as the service role (no RLS) — the
 *  numbers pdm.vault_cursor is supposed to reproduce for a member. */
async function trueCounts(vaultId: string) {
  const svc = serviceClient();
  const { count: liveFiles } = await svc.from("files")
    .select("id", { count: "exact", head: true }).eq("vault_id", vaultId).is("deleted_at", null);
  const { count: versions } = await svc.from("versions")
    .select("id, files!versions_file_id_fkey!inner(vault_id)", { count: "exact", head: true })
    .eq("files.vault_id", vaultId);
  const { count: liveFolders } = await svc.from("folders")
    .select("id", { count: "exact", head: true }).eq("vault_id", vaultId).is("deleted_at", null);
  const { count: activeLocks } = await svc.from("locks")
    .select("id, files!inner(vault_id)", { count: "exact", head: true })
    .eq("files.vault_id", vaultId).is("released_at", null);
  return {
    live_files: liveFiles ?? 0,
    versions: versions ?? 0,
    live_folders: liveFolders ?? 0,
    active_locks: activeLocks ?? 0,
  };
}

/** A `returns table` RPC comes back as an array of rows. */
function rows<T = Record<string, unknown>>(data: unknown): T[] {
  return (Array.isArray(data) ? data : data == null ? [] : [data]) as T[];
}

/** PostgREST renders bigint as a JSON number, but be explicit so a driver that
 *  hands back a string can't make an assertion pass by coincidence. */
function nums(r: Record<string, unknown>) {
  return {
    live_files: Number(r.live_files),
    versions: Number(r.versions),
    live_folders: Number(r.live_folders),
    active_locks: Number(r.active_locks),
  };
}

describe("pdm.vault_cursor", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("returns the real counts for a GLOBAL member", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer"); // global role — authoritative everywhere
    const a = await seedVault(admin.id, { lockHolderId: admin.id, draftBy: admin.id });

    const c = await signInAs(viewer.email!);
    const { data, error } = await c.rpc("vault_cursor", { p_vault_id: a.vaultId });
    expect(error).toBeNull();
    const row = rows(data)[0];
    expect(row).toBeTruthy();
    expect(nums(row!)).toEqual(await trueCounts(a.vaultId));
    // The counts are a change SIGNAL, not a visibility statement: the draft
    // another user cannot read is still counted. That is deliberate (the
    // client never displays these numbers) and this pins it, because a future
    // "fix" that filtered by visibility would make the signature miss changes.
    expect(nums(row!).live_files).toBe(2);
  });

  it("answers zeros for a vault the caller is not a member of", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member")); // no global role
    const a = await seedVault(admin.id, { lockHolderId: admin.id });
    const b = await seedVault(admin.id, { lockHolderId: admin.id });
    await setVaultRole(member.id, "viewer", a.vaultId); // vault A only

    const c = await signInAs(member.email!);

    const { data: inA } = await c.rpc("vault_cursor", { p_vault_id: a.vaultId });
    expect(nums(rows(inA)[0]!)).toEqual(await trueCounts(a.vaultId));

    // Vault B exists and is non-empty; a non-member must learn nothing about it.
    const { data: inB } = await c.rpc("vault_cursor", { p_vault_id: b.vaultId });
    expect(nums(rows(inB)[0]!)).toEqual({
      live_files: 0, versions: 0, live_folders: 0, active_locks: 0,
    });
  });

  it("is not executable by anon", async () => {
    // The migration revokes execute from public/anon; a definer function that
    // counted for an unauthenticated caller would be a straight data leak.
    const c = anonClient();
    const { error } = await c.rpc("vault_cursor", { p_vault_id: "00000000-0000-0000-0000-000000000000" });
    expect(error).not.toBeNull();
  });
});

describe("pm.workspace_cursor", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("returns no row at all for a user with no org role", async () => {
    const nobody = await createTestUser(uniqueEmail("nobody"));
    const c = await signInAs(nobody.email!);
    const { data, error } = await c.schema("pm").rpc("workspace_cursor");
    expect(error).toBeNull();
    // The WHERE clause filters the whole result away — the client reads that as
    // "no access, nothing changed" rather than as a signature of zeros.
    expect(rows(data)).toHaveLength(0);
  });

  it("returns one row of counts for a member", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin"); // a pdm role makes them an org member
    const c = await signInAs(admin.email!);
    const { data, error } = await c.schema("pm").rpc("workspace_cursor");
    expect(error).toBeNull();
    const r = rows(data);
    expect(r).toHaveLength(1);
    const svc = serviceClient();
    const { count: tasks } = await svc.schema("pm").from("tasks")
      .select("id", { count: "exact", head: true });
    expect(Number(r[0]!.tasks)).toBe(tasks ?? 0);
  });
});

describe("pdm.bridge_live_files", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("returns exactly the ids the same user sees through RLS", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member"));
    // Their own draft in A (visible to them), someone else's draft in A
    // (hidden), and a whole vault B they have no role in (hidden).
    const a = await seedVault(admin.id, { draftBy: admin.id });
    const b = await seedVault(admin.id, { draftBy: admin.id });
    await setVaultRole(member.id, "editor", a.vaultId);
    const svc = serviceClient();
    const { data: own } = await svc.from("files")
      .insert({ vault_id: a.vaultId, folder_id: a.folderId, name: "mine.sldprt", created_by: member.id })
      .select().single();

    const c = await signInAs(member.email!);
    const { data: viaRls, error: rlsErr } = await c.from("files")
      .select("id").is("deleted_at", null);
    expect(rlsErr).toBeNull();
    const { data: viaRpc, error: rpcErr } = await c.rpc("bridge_live_files");
    expect(rpcErr).toBeNull();

    const sortIds = (xs: Array<{ id: string }>) => xs.map((r) => r.id).sort();
    expect(sortIds(rows<{ id: string }>(viaRpc))).toEqual(sortIds((viaRls ?? []) as Array<{ id: string }>));

    // And the set is the one we expect, so an equivalence of two BROKEN paths
    // (both returning nothing) can't pass this test.
    expect(sortIds(rows<{ id: string }>(viaRpc))).toEqual([a.fileId, own!.id].sort());
    expect(sortIds(rows<{ id: string }>(viaRpc))).not.toContain(b.fileId);
    expect(sortIds(rows<{ id: string }>(viaRpc))).not.toContain(a.draftId);
  });

  it("excludes soft-deleted files", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const a = await seedVault(admin.id);
    const svc = serviceClient();
    await svc.from("files").update({ deleted_at: new Date().toISOString() }).eq("id", a.fileId);

    const c = await signInAs(admin.email!);
    const { data } = await c.rpc("bridge_live_files");
    expect(rows<{ id: string }>(data).map((r) => r.id)).not.toContain(a.fileId);
  });
});

describe("read policies after the my_vault_ids rewrite (20260909100300)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  // Same assertions as rls-vault-scoped-reads / rls-per-vault-roles: the
  // rewrite is a planner change, so visibility must be byte-for-byte the same.
  it("a per-vault member reads their vault and NOT another vault's rows", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const member = await createTestUser(uniqueEmail("member")); // no global role
    const a = await seedVault(admin.id, { lockHolderId: admin.id });
    const b = await seedVault(admin.id, { lockHolderId: admin.id });
    await setVaultRole(member.id, "editor", a.vaultId);

    const c = await signInAs(member.email!);

    const { data: filesA } = await c.from("files").select("id").eq("vault_id", a.vaultId);
    expect(filesA?.map((r) => r.id)).toContain(a.fileId);
    const { data: foldersA } = await c.from("folders").select("id").eq("vault_id", a.vaultId);
    expect(foldersA?.map((r) => r.id)).toContain(a.folderId);
    const { data: versionsA } = await c.from("versions").select("id").eq("file_id", a.fileId);
    expect(versionsA?.map((r) => r.id)).toContain(a.versionId);
    const { data: locksA } = await c.from("locks").select("id").eq("file_id", a.fileId);
    expect(locksA ?? []).toHaveLength(1);

    const { data: filesB } = await c.from("files").select("id").eq("vault_id", b.vaultId);
    expect(filesB ?? []).toHaveLength(0);
    const { data: foldersB } = await c.from("folders").select("id").eq("vault_id", b.vaultId);
    expect(foldersB ?? []).toHaveLength(0);
    const { data: versionsB } = await c.from("versions").select("id").eq("file_id", b.fileId);
    expect(versionsB ?? []).toHaveLength(0);
    const { data: locksB } = await c.from("locks").select("id").eq("file_id", b.fileId);
    expect(locksB ?? []).toHaveLength(0);
  });

  it("a GLOBAL role row stays authoritative in every vault", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer"); // vault_id NULL
    const a = await seedVault(admin.id);
    const b = await seedVault(admin.id);

    const c = await signInAs(viewer.email!);
    const { data: files } = await c.from("files").select("id");
    const ids = (files ?? []).map((r) => r.id);
    expect(ids).toContain(a.fileId);
    expect(ids).toContain(b.fileId);
  });

  it("a role-less user still reads nothing", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const nobody = await createTestUser(uniqueEmail("nobody"));
    const a = await seedVault(admin.id, { lockHolderId: admin.id });

    const c = await signInAs(nobody.email!);
    const { data: files } = await c.from("files").select("id");
    expect(files ?? []).toHaveLength(0);
    const { data: folders } = await c.from("folders").select("id");
    expect(folders ?? []).toHaveLength(0);
    const { data: versions } = await c.from("versions").select("id").eq("file_id", a.fileId);
    expect(versions ?? []).toHaveLength(0);
    const { data: locks } = await c.from("locks").select("id").eq("file_id", a.fileId);
    expect(locks ?? []).toHaveLength(0);
  });

  it("another user's unpublished draft stays hidden, the caller's own stays visible", async () => {
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const editor = await createTestUser(uniqueEmail("editor"));
    await setRole(editor.id, "editor");
    const a = await seedVault(admin.id, { draftBy: admin.id }); // admin's draft
    const svc = serviceClient();
    const { data: own } = await svc.from("files")
      .insert({ vault_id: a.vaultId, folder_id: a.folderId, name: "mine.sldprt", created_by: editor.id })
      .select().single();

    const c = await signInAs(editor.email!);
    const { data: files } = await c.from("files").select("id").eq("vault_id", a.vaultId);
    const ids = (files ?? []).map((r) => r.id);
    expect(ids).toContain(a.fileId);   // published
    expect(ids).toContain(own!.id);    // own draft
    expect(ids).not.toContain(a.draftId); // someone else's draft
  });
});
