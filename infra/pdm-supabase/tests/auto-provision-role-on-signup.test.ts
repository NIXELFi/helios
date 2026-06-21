import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  uniqueEmail,
} from "./setup.js";

// Regression for the new-signup lockout (20260619000700_pdm_auto_provision_role_on_signup).
//
// Vault access is gated entirely through pdm.user_roles (is_member_in / is_admin /
// can_edit_in all return false with no row). Before this fix a brand-new auth user
// got NO role row, so every new member was silently locked out of the vault with no
// automated remedy. The on_auth_user_created trigger now grants the baseline global
// 'editor' role on signup.

describe("auto-provision vault role on signup", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("grants a new signup a baseline global 'editor' role", async () => {
    const user = await createTestUser(uniqueEmail("newbie"));

    const svc = serviceClient();
    const { data, error } = await svc
      .from("user_roles")
      .select("role, vault_id")
      .eq("user_id", user.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].role).toBe("editor");
    expect(data![0].vault_id).toBeNull();
  });

  it("does NOT auto-grant admin/owner (no escalation via self-selected subteam)", async () => {
    const user = await createTestUser(uniqueEmail("notanadmin"));

    const svc = serviceClient();
    const { data } = await svc
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    expect(data!.every((r) => r.role === "editor")).toBe(true);
    expect(data!.some((r) => r.role === "admin" || r.role === "owner")).toBe(false);
  });
});
