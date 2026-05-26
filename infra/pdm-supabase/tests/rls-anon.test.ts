import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anonClient,
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  uniqueEmail,
} from "./setup.js";

// Anon-denial canary suite — added 2026-05-25 per the audit.
//
// PostgREST auto-exposes every table in any granted schema, so the single
// most common Supabase misconfiguration is "I added a new table and forgot
// to lock it down for anon." This file fails loudly if any pdm.* table
// becomes readable, writable, or RPC-callable by an unauthenticated client.
//
// Coverage policy: every table that exists in pdm.* must have one anon
// SELECT-denial test below. Every mutating action (INSERT/UPDATE/DELETE)
// is covered for at least one representative table. Every public.pdm_*
// proxy RPC has an anon-denial test.
//
// PostgREST + Postgres surface anon-denial through several shapes, depending
// on whether the role lacks a grant, has the grant but no RLS policy, or
// the function body raises an exception. Treat all of these as "denial":
//
//   - 42501            "permission denied for ..."        (grant denial)
//   - 42P01            "relation does not exist"          (schema not exposed)
//   - PGRST106         "schema not exposed"               (PostgREST gate)
//   - PGRST202         "function not found in schema cache" (no grant for role)
//   - PGRST301         JWT / auth errors
//   - P0001 with "authentication required"  (RPC body's RAISE EXCEPTION)
//   - status 401/403                        (PostgREST/Storage auth gates)
//   - StorageApiError with statusCode "403" "new row violates RLS"
//
// A test that gets `null` error but ALSO empty `data` from RLS-filter-to-zero
// counts as denial via the `dataEmpty` argument — for cases where Postgres
// silently returns 0 rows for forbidden UPDATE/DELETE/SELECT (PostgREST does
// not surface this as an error; the operation just affects nothing). Callers
// pass `dataEmpty: true` when an empty-data response is also acceptable
// (storage list, RLS-filtered SELECT). Otherwise null-error is a HOLE.

function assertDenied(
  error: { code?: string; status?: number; statusCode?: string; message?: string } | null,
  dataEmpty?: boolean,
) {
  if (error === null) {
    if (dataEmpty) return; // RLS filtered to zero rows; equivalent to denial
    throw new Error("expected an auth error but got null (operation succeeded for anon — this is a hole)");
  }
  const sqlCode = error.code;
  // Some clients put the wire HTTP status in `status`; the Storage SDK uses
  // `status: 400` to mean "client error" and puts the real HTTP code in
  // `statusCode` (as a string). Check both independently.
  const status = error.status ?? 0;
  const statusCode = Number(error.statusCode ?? 0);
  const msg = error.message ?? "";
  const ok =
    sqlCode === "42501" ||
    sqlCode === "42P01" ||
    sqlCode === "PGRST106" ||
    sqlCode === "PGRST202" ||
    sqlCode === "PGRST301" ||
    sqlCode === "P0001" ||
    status === 401 || status === 403 || status === 404 ||
    statusCode === 401 || statusCode === 403 || statusCode === 404 ||
    /permission denied|not allowed|JWT|unauthorized|authentication required|violates row-level security|column .* of .* in the schema cache|object not found/i.test(msg);
  expect(ok, `expected denial error, got ${JSON.stringify(error)}`).toBe(true);
}

describe("anon (unauthenticated) is denied on every pdm.* surface", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  describe("SELECT denial on every table", () => {
    it("vaults", async () => {
      const c = anonClient();
      const { error } = await c.from("vaults").select("*").limit(1);
      assertDenied(error as any);
    });

    it("folders", async () => {
      const c = anonClient();
      const { error } = await c.from("folders").select("*").limit(1);
      assertDenied(error as any);
    });

    it("files", async () => {
      const c = anonClient();
      const { error } = await c.from("files").select("*").limit(1);
      assertDenied(error as any);
    });

    it("versions", async () => {
      const c = anonClient();
      const { error } = await c.from("versions").select("*").limit(1);
      assertDenied(error as any);
    });

    it("locks", async () => {
      const c = anonClient();
      const { error } = await c.from("locks").select("*").limit(1);
      assertDenied(error as any);
    });

    it("user_roles", async () => {
      const c = anonClient();
      const { error } = await c.from("user_roles").select("*").limit(1);
      assertDenied(error as any);
    });

    it("audit_log", async () => {
      const c = anonClient();
      const { error } = await c.from("audit_log").select("*").limit(1);
      assertDenied(error as any);
    });
  });

  describe("INSERT denial", () => {
    it("anon cannot INSERT into vaults", async () => {
      const c = anonClient();
      const { error } = await c.from("vaults").insert({
        name: "anon-vault",
        created_by: "00000000-0000-0000-0000-000000000000",
      });
      assertDenied(error as any);
    });

    it("anon cannot INSERT into folders", async () => {
      const c = anonClient();
      const { error } = await c.from("folders").insert({
        vault_id: "00000000-0000-0000-0000-000000000000",
        name: "anon-folder",
      });
      assertDenied(error as any);
    });

    it("anon cannot INSERT into files", async () => {
      const c = anonClient();
      const { error } = await c.from("files").insert({
        vault_id: "00000000-0000-0000-0000-000000000000",
        folder_id: null,
        name: "anon.sldprt",
      });
      assertDenied(error as any);
    });

    it("anon cannot INSERT into versions", async () => {
      const c = anonClient();
      const { error } = await c.from("versions").insert({
        file_id: "00000000-0000-0000-0000-000000000000",
        version_num: 1,
        sha256: "a".repeat(64),
        size_bytes: 1,
      });
      assertDenied(error as any);
    });

    it("anon cannot INSERT into locks", async () => {
      const c = anonClient();
      const { error } = await c.from("locks").insert({
        file_id: "00000000-0000-0000-0000-000000000000",
        user_id: "00000000-0000-0000-0000-000000000000",
      });
      assertDenied(error as any);
    });

    it("anon cannot INSERT into user_roles (self-elevation guard)", async () => {
      const c = anonClient();
      const { error } = await c.from("user_roles").insert({
        user_id: "00000000-0000-0000-0000-000000000000",
        role: "admin",
      });
      assertDenied(error as any);
    });

    it("anon cannot INSERT into audit_log (tamper guard)", async () => {
      const c = anonClient();
      // `payload` is the real column (per 20260507000000); the wrong-column
      // version of this test would PGRST204 against the schema cache, which
      // is technically also a form of denial but obscures the actual grant
      // check. Use only existing columns so the test fails for the right
      // reason.
      const { error } = await c.from("audit_log").insert({
        action: "spoofed",
        target_type: "test",
      });
      assertDenied(error as any);
    });
  });

  describe("UPDATE/DELETE denial on seeded rows", () => {
    it("anon cannot UPDATE a vault (admin-seeded)", async () => {
      const admin = await createTestUser(uniqueEmail("admin"));
      await setRole(admin.id, "admin");
      const svc = serviceClient();
      const { data: v } = await svc
        .from("vaults").insert({ name: "v", created_by: admin.id }).select().single();

      const c = anonClient();
      const { error } = await c.from("vaults").update({ name: "tampered" }).eq("id", v!.id);
      assertDenied(error as any);
    });

    it("anon cannot DELETE a lock (admin-seeded)", async () => {
      const admin = await createTestUser(uniqueEmail("admin"));
      await setRole(admin.id, "admin");
      const editor = await createTestUser(uniqueEmail("editor"));
      await setRole(editor.id, "editor");
      const svc = serviceClient();
      const { data: v } = await svc
        .from("vaults").insert({ name: "v", created_by: admin.id }).select().single();
      const { data: f } = await svc
        .from("folders").insert({ vault_id: v!.id, name: "p" }).select().single();
      const { data: file } = await svc
        .from("files").insert({ vault_id: v!.id, folder_id: f!.id, name: "x.sldprt" }).select().single();
      const { data: lock } = await svc
        .from("locks").insert({ file_id: file!.id, user_id: editor.id }).select().single();

      const c = anonClient();
      const { error } = await c.from("locks").delete().eq("id", lock!.id);
      assertDenied(error as any);
    });
  });

  describe("RPC denial — every public.pdm_* proxy", () => {
    // Migration 20260511001000 explicitly revoked EXECUTE from anon on every
    // public.pdm_* proxy. This canary makes that policy load-bearing rather
    // than incidental.

    it("anon cannot call pdm_is_admin (returns false / denial, never true)", async () => {
      const c = anonClient();
      const { data, error } = await c.rpc("pdm_is_admin");
      // pdm.is_admin() reads auth.uid() which is null for anon, so it
      // returns FALSE rather than raising. That is acceptable behavior —
      // it cannot return true for an unauthenticated caller. The denial
      // semantics we care about for THIS test is "not true": if data ever
      // came back as `true`, anon could read admin-only data via a stale
      // assumption that is_admin === false. Accept null/false; flag true.
      if (error) {
        assertDenied(error as any);
      } else {
        expect(data).not.toBe(true);
      }
    });

    it("anon cannot call pdm_check_in", async () => {
      const c = anonClient();
      const { error } = await c.rpc("pdm_check_in", {
        p_file_id: "00000000-0000-0000-0000-000000000000",
        p_sha256: "a".repeat(64),
        p_size: 1,
        p_comment: null,
      });
      assertDenied(error as any);
    });

    it("anon cannot call pdm_add_and_lock", async () => {
      const c = anonClient();
      const { error } = await c.rpc("pdm_add_and_lock", {
        p_vault_id: "00000000-0000-0000-0000-000000000000",
        p_folder_id: null,
        p_name: "x",
        p_sha256: "a".repeat(64),
        p_size: 1,
        p_comment: null,
      });
      assertDenied(error as any);
    });

    it("anon cannot call pdm_cancel_checkout", async () => {
      const c = anonClient();
      const { error } = await c.rpc("pdm_cancel_checkout", {
        p_file_id: "00000000-0000-0000-0000-000000000000",
      });
      assertDenied(error as any);
    });

    it("anon cannot call pdm_force_unlock", async () => {
      const c = anonClient();
      const { error } = await c.rpc("pdm_force_unlock", {
        p_lock_id: "00000000-0000-0000-0000-000000000000",
        p_reason: "spoofed",
      });
      assertDenied(error as any);
    });

    it("anon cannot call pdm_import_version (service-role-only RPC)", async () => {
      const c = anonClient();
      const { error } = await c.rpc("pdm_import_version", {
        p_vault_id: "00000000-0000-0000-0000-000000000000",
        p_folder_id: null,
        p_name: "x",
        p_sha256: "a".repeat(64),
        p_size: 1,
        p_comment: null,
        p_created_at: new Date().toISOString(),
        p_import_metadata: {},
      });
      assertDenied(error as any);
    });
  });

  describe("Storage denial", () => {
    it("anon list of vault-objects returns nothing visible", async () => {
      // Seed an object so the bucket is non-empty under service role; anon's
      // list must still come back empty (or 4xx). RLS filters list() to the
      // empty set rather than raising, which is operationally equivalent to
      // denial — no object names leak.
      const svc = serviceClient();
      const sha = "e".repeat(64);
      const path = `${sha.slice(0, 2)}/${sha}`;
      const { error: upErr } = await svc.storage
        .from("vault-objects")
        .upload(path, new Uint8Array([1, 2, 3]), {
          contentType: "application/octet-stream",
          upsert: true,
        });
      expect(upErr).toBeNull();

      const c = anonClient();
      const { data, error } = await c.storage.from("vault-objects").list();
      assertDenied(error as any, /*dataEmpty*/ (data ?? []).length === 0);

      await svc.storage.from("vault-objects").remove([path]);
    });

    it("anon cannot download from vault-objects by sha path", async () => {
      // Seed an object via service-role so the path exists. Anon should be
      // denied even with the exact path — the bucket is role-gated, not
      // public. (Storage RLS returns 404 "object not found" rather than 403
      // when the policy hides existence; that's the documented Storage
      // behavior and still counts as denial.)
      const svc = serviceClient();
      const sha = "f".repeat(64);
      const path = `${sha.slice(0, 2)}/${sha}`;
      const { error: upErr } = await svc.storage
        .from("vault-objects")
        .upload(path, new Uint8Array([1, 2, 3]), {
          contentType: "application/octet-stream",
          upsert: true,
        });
      expect(upErr).toBeNull();

      const c = anonClient();
      const { error } = await c.storage.from("vault-objects").download(path);
      assertDenied(error as any);

      await svc.storage.from("vault-objects").remove([path]);
    });

    it("anon cannot upload to vault-objects", async () => {
      const c = anonClient();
      const { error } = await c.storage
        .from("vault-objects")
        .upload("ff/forbidden", new Uint8Array([1]), {
          contentType: "application/octet-stream",
        });
      assertDenied(error as any);
    });
  });
});
