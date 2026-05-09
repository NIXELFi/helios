import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

describe("user_roles RLS", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("authenticated users can read their own role", async () => {
    const email = uniqueEmail("editor");
    const u = await createTestUser(email);
    await setRole(u.id, "editor");

    const c = await signInAs(email);
    const { data, error } = await c.from("user_roles").select("role").eq("user_id", u.id).single();
    expect(error).toBeNull();
    expect(data?.role).toBe("editor");
  });

  it("a non-admin cannot insert into user_roles", async () => {
    const email = uniqueEmail("editor");
    const u = await createTestUser(email);
    await setRole(u.id, "editor");
    const c = await signInAs(email);

    const target = await createTestUser(uniqueEmail("target"));
    const { error } = await c.from("user_roles").insert({ user_id: target.id, role: "editor" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501"); // permission denied
  });

  it("an admin can insert into user_roles", async () => {
    const email = uniqueEmail("admin");
    const u = await createTestUser(email);
    await setRole(u.id, "admin");
    const c = await signInAs(email);

    const target = await createTestUser(uniqueEmail("target"));
    const { error } = await c.from("user_roles").insert({ user_id: target.id, role: "viewer" });
    expect(error).toBeNull();
  });

  it("pdm.is_admin() returns true for admins, false for editors", async () => {
    const adminEmail = uniqueEmail("admin");
    const a = await createTestUser(adminEmail);
    await setRole(a.id, "admin");
    const ac = await signInAs(adminEmail);
    const { data: aRes } = await ac.rpc("pdm_is_admin");
    expect(aRes).toBe(true);

    const editorEmail = uniqueEmail("editor");
    const e = await createTestUser(editorEmail);
    await setRole(e.id, "editor");
    const ec = await signInAs(editorEmail);
    const { data: eRes } = await ec.rpc("pdm_is_admin");
    expect(eRes).toBe(false);
  });
});
