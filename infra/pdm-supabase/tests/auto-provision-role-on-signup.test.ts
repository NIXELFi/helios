import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetAuthUsers,
  serviceClient,
  uniqueEmail,
} from "./setup.js";

// Regression for the new-signup lockout (20260619000700_pdm_auto_provision_role_on_signup)
// and the C-1 security fix (20260622000200_pdm_signup_baseline_viewer).
//
// Vault access is gated entirely through pdm.user_roles (is_member_in / is_admin /
// can_edit_in all return false with no row). The on_auth_user_created trigger grants
// a baseline GLOBAL role on signup so a new member isn't silently locked out.
//
// C-1: that baseline used to be 'editor', which let any anon-key self-signup
// upload/modify files in EVERY vault. It is now 'viewer' (read-only) — an admin
// must promote before the account can write.
//
// NOTE: these tests create the user via the admin API DIRECTLY rather than the
// createTestUser() helper, because that helper deliberately strips the
// auto-provisioned role (to give the rest of the suite a clean-slate baseline).
// Here we want to observe the trigger's effect, so we must not strip it.

async function signUpRaw(email: string) {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!;
}

describe("auto-provision vault role on signup", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("grants a new signup a baseline global 'viewer' role (read-only, C-1)", async () => {
    const user = await signUpRaw(uniqueEmail("newbie"));

    const svc = serviceClient();
    const { data, error } = await svc
      .from("user_roles")
      .select("role, vault_id")
      .eq("user_id", user.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    // C-1: baseline must be 'viewer', NOT 'editor' — a self-signup cannot
    // upload/modify until an admin promotes it.
    expect(data![0].role).toBe("viewer");
    expect(data![0].vault_id).toBeNull();
  });

  it("does NOT auto-grant editor/admin/owner (no write/escalation on signup)", async () => {
    const user = await signUpRaw(uniqueEmail("notanadmin"));

    const svc = serviceClient();
    const { data } = await svc
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    expect(data!.every((r) => r.role === "viewer")).toBe(true);
    expect(data!.some((r) => r.role === "editor" || r.role === "admin" || r.role === "owner")).toBe(false);
  });
});
