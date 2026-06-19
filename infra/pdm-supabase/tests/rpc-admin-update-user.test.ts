import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// Regression for H10: pdm.admin_update_user must reject a non-owner admin from
// editing the owner account (20260619000100_pdm_admin_update_user_owner_guard).
//
// Before the fix, any global admin could overwrite the owner's display_name /
// subteam via admin_update_user. The fix mirrors the guard already present in
// admin_delete_user: look up the target's global role; if 'owner' and caller is
// not pdm.is_owner(), raise 'only the owner can edit the owner account'.

describe("pdm.admin_update_user() — owner-guard (H10)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("rejects a non-owner admin editing the owner account", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");

    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");

    const ac = await signInAs(admin.email!);
    const { error } = await ac.rpc("pdm_admin_update_user", {
      p_target: owner.id,
      p_display_name: "hacked",
      p_subteam: "hacked",
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/only the owner can edit the owner account/i);
  });

  it("allows the owner to edit the owner account", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");

    const oc = await signInAs(owner.email!);
    const { error } = await oc.rpc("pdm_admin_update_user", {
      p_target: owner.id,
      p_display_name: "Owner Updated",
      p_subteam: "Exec",
    });

    expect(error).toBeNull();

    // Verify the metadata was actually written.
    const svc = serviceClient();
    const { data: user } = await svc.auth.admin.getUserById(owner.id);
    expect(user.user?.user_metadata?.display_name).toBe("Owner Updated");
    expect(user.user?.user_metadata?.subteam).toBe("Exec");
  });

  it("allows an admin to edit a normal (non-owner) user", async () => {
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner");

    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");

    const target = await createTestUser(uniqueEmail("editor"));
    await setRole(target.id, "editor");

    const ac = await signInAs(admin.email!);
    const { error } = await ac.rpc("pdm_admin_update_user", {
      p_target: target.id,
      p_display_name: "Updated Name",
      p_subteam: "Aero",
    });

    expect(error).toBeNull();

    const svc = serviceClient();
    const { data: user } = await svc.auth.admin.getUserById(target.id);
    expect(user.user?.user_metadata?.display_name).toBe("Updated Name");
    expect(user.user?.user_metadata?.subteam).toBe("Aero");
  });
});
