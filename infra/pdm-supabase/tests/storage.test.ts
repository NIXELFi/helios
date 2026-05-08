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

  it("authenticated user can read via signed download URL", async () => {
    const u = await createTestUser(uniqueEmail("editor"));
    await setRole(u.id, "editor");
    const sha = "deadbeef".padEnd(64, "0");
    const objectPath = `${sha.slice(0, 2)}/${sha}`;

    // Seed via service client.
    const svc = serviceClient();
    await svc.storage.from(BUCKET).upload(objectPath, new Uint8Array([1, 2, 3]), {
      contentType: "application/octet-stream",
      upsert: true,
    });

    const c = await signInAs(u.email!);
    const { data, error } = await c.storage.from(BUCKET).createSignedUrl(objectPath, 60);
    expect(error).toBeNull();
    const got = await fetch(data!.signedUrl);
    expect(got.ok).toBe(true);
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});
