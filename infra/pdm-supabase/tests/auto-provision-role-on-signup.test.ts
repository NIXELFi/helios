import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetAuthUsers,
  serviceClient,
  uniqueEmail,
} from "./setup.js";

// Signup provisioning history:
//   20260619000700 granted every new signup a baseline GLOBAL 'editor'
//   (new-member lockout fix) → 20260622000200 softened it to 'viewer' (C-1:
//   an anon-key self-signup could write to every vault) → 20260714010000
//   removed auto-provisioning entirely (owner decision: team data is IP; a
//   fresh account gets NOTHING until a lead/exec grants a role via Org &
//   Access or the vault role editor — the app shows a "contact your team
//   lead" screen for role-less accounts).
//
// NOTE: these tests create the user via the admin API DIRECTLY rather than the
// createTestUser() helper, because that helper defensively strips any
// provisioned role. Here we observe the signup path itself.

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

describe("signup provisioning (default-deny)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("grants a new signup NO pdm role at all", async () => {
    const user = await signUpRaw(uniqueEmail("newbie"));

    const svc = serviceClient();
    const { data, error } = await svc
      .from("user_roles")
      .select("role, vault_id")
      .eq("user_id", user.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
