import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/**
 * 20260721000400: pm.revoke_role serializes owner-revokes behind a
 * pg_advisory_xact_lock before the "never strand the org without an owner"
 * count, so two concurrent revoke_role(x, 'owner') calls on different owners
 * can't both pass the `count <= 1` guard and leave zero owners.
 *
 * The true two-transaction race can't be exercised from vitest (PostgREST
 * gives each RPC its own short transaction and the lock is xact-scoped), so
 * this suite asserts the guard logic the lock protects: the last owner can
 * never be revoked, and revoking one of two owners works and leaves one.
 */

/** Grants the pm org-scoped 'owner' role directly (service role bypasses pm RLS). */
async function grantOwner(userId: string): Promise<void> {
  const svc = serviceClient().schema("pm");
  const { data: role, error: roleErr } = await svc
    .from("roles")
    .select("id")
    .eq("key", "owner")
    .single();
  if (roleErr) throw roleErr;
  const { error } = await svc
    .from("role_memberships")
    .insert({ user_id: userId, role_id: role!.id, subteam_id: null });
  if (error) throw error;
}

/** Counts current owner-role memberships (service role bypasses pm RLS). */
async function ownerCount(): Promise<number> {
  const svc = serviceClient().schema("pm");
  const { data: role, error: roleErr } = await svc
    .from("roles")
    .select("id")
    .eq("key", "owner")
    .single();
  if (roleErr) throw roleErr;
  const { data: rows, error } = await svc
    .from("role_memberships")
    .select("user_id")
    .eq("role_id", role!.id);
  if (error) throw error;
  return rows!.length;
}

describe("pm.revoke_role — last-owner guard", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("refuses to revoke the only owner", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await grantOwner(owner.id);

    const c = await signInAs(owner.email!);
    const { error } = await c.schema("pm").rpc("revoke_role", {
      p_target: owner.id,
      p_role_key: "owner",
      p_subteam_id: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/cannot remove the last owner/i);
    expect(await ownerCount()).toBe(1);
  });

  it("revoking one of two owners succeeds and leaves exactly one", async () => {
    const owner1 = await createTestUser(uniqueEmail("owner1"));
    await grantOwner(owner1.id);
    const owner2 = await createTestUser(uniqueEmail("owner2"));
    await grantOwner(owner2.id);
    expect(await ownerCount()).toBe(2);

    const c = await signInAs(owner1.email!);
    const { error } = await c.schema("pm").rpc("revoke_role", {
      p_target: owner2.id,
      p_role_key: "owner",
      p_subteam_id: null,
    });
    expect(error).toBeNull();
    expect(await ownerCount()).toBe(1);

    // ...and the survivor is now protected as the last owner.
    const { error: lastErr } = await c.schema("pm").rpc("revoke_role", {
      p_target: owner1.id,
      p_role_key: "owner",
      p_subteam_id: null,
    });
    expect(lastErr).not.toBeNull();
    expect(lastErr!.message).toMatch(/cannot remove the last owner/i);
    expect(await ownerCount()).toBe(1);
  });

  it("authorization gate intact: a plain member cannot revoke an owner", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await grantOwner(owner.id);
    const member = await createTestUser(uniqueEmail("member")); // no pm role

    const c = await signInAs(member.email!);
    const { error } = await c.schema("pm").rpc("revoke_role", {
      p_target: owner.id,
      p_role_key: "owner",
      p_subteam_id: null,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/only an owner may revoke/i);
    expect(await ownerCount()).toBe(1);
  });
});
