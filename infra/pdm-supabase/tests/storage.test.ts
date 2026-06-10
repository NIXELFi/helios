import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

const BUCKET = "vault-objects";

describe("vault-objects storage bucket", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("bucket exists and is private", async () => {
    const svc = serviceClient();
    const { data, error } = await svc.storage.getBucket(BUCKET);
    expect(error).toBeNull();
    expect(data?.public).toBe(false);
  });

  it("authenticated user can request a signed upload URL and PUT bytes", async () => {
    const u = await createTestUser(uniqueEmail("editor"));
    await setRole(u.id, "editor");
    const c = await signInAs(u.email!);

    const sha = "abcdef".padEnd(64, "0");
    const objectPath = `${sha.slice(0, 2)}/${sha}`;

    // Request signed upload URL.
    const { data: signed, error: signErr } = await c.storage
      .from(BUCKET)
      .createSignedUploadUrl(objectPath);
    expect(signErr).toBeNull();
    expect(signed?.signedUrl).toBeTruthy();

    // PUT bytes via fetch using the signed URL.
    const body = new TextEncoder().encode("hello vault");
    const putRes = await fetch(signed!.signedUrl, {
      method: "PUT",
      body,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(putRes.ok).toBe(true);

    // Confirm the object exists by re-listing.
    const svc = serviceClient();
    const { data: list } = await svc.storage.from(BUCKET).list(sha.slice(0, 2));
    expect(list?.some((f) => f.name === sha)).toBe(true);
  });

  it("authenticated user can read via signed download URL (sha referenced by their vault)", async () => {
    const u = await createTestUser(uniqueEmail("editor"));
    await setRole(u.id, "editor");
    const sha = "deadbeef".padEnd(64, "0");
    const objectPath = `${sha.slice(0, 2)}/${sha}`;

    // Seed object + a version referencing the sha via service client. The
    // bucket SELECT policy (20260610110000) is vault-scoped: an object is
    // readable only if some version of a file in one of the caller's vaults
    // carries that sha.
    const svc = serviceClient();
    await svc.storage.from(BUCKET).upload(objectPath, new Uint8Array([1, 2, 3]), {
      contentType: "application/octet-stream",
      upsert: true,
    });
    const { data: v } = await svc.from("vaults")
      .insert({ name: `v-${Date.now()}`, created_by: u.id }).select().single();
    const { data: f } = await svc.from("files")
      .insert({ vault_id: v!.id, folder_id: null, name: "part.sldprt", created_by: u.id, published_at: new Date().toISOString() })
      .select().single();
    await svc.from("versions")
      .insert({ file_id: f!.id, version_num: 1, sha256: sha, size_bytes: 3, author_id: u.id });

    const c = await signInAs(u.email!);
    const { data, error } = await c.storage.from(BUCKET).createSignedUrl(objectPath, 60);
    expect(error).toBeNull();
    const got = await fetch(data!.signedUrl);
    expect(got.ok).toBe(true);
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("role holder CANNOT sign a download for content no vault of theirs references", async () => {
    // The 2026-06-09 audit critical: any role holder could download any
    // vault's content. The sha-scoped SELECT policy must deny signing for an
    // object that exists but is referenced by no vault the caller belongs to.
    const u = await createTestUser(uniqueEmail("editor"));
    await setRole(u.id, "editor"); // global role, but no vault references this sha
    const sha = "0ddba11".padEnd(64, "0");
    const objectPath = `${sha.slice(0, 2)}/${sha}`;

    const svc = serviceClient();
    await svc.storage.from(BUCKET).upload(objectPath, new Uint8Array([9, 9, 9]), {
      contentType: "application/octet-stream",
      upsert: true,
    });

    const c = await signInAs(u.email!);
    const { data, error } = await c.storage.from(BUCKET).createSignedUrl(objectPath, 60);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
