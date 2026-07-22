import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/**
 * 20260722000000: pm.my_team_roles() — the PM UI's only role source — reports
 * pm.effective_role per project instead of raw pm.team_memberships. Before the
 * bridge, a capability-only member (Org & Access grant, no team_memberships
 * row) read as "no role" and the PM UI disabled every edit control, while the
 * RLS edit gates (already bridged in 20260714030000) accepted their writes.
 */

async function seedProject(): Promise<string> {
  const svc = serviceClient().schema("pm");
  // car_code is UNIQUE and projects survive between tests (resetAuthUsers only
  // wipes auth) — make it unique per call.
  const tag = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const { data, error } = await svc
    .from("projects")
    .insert({ name: `proj-${tag}`, car_year: 2026, car_code: `T${tag}` })
    .select()
    .single();
  if (error) throw error;
  return data!.id;
}

/** Grant a pm role membership directly (service role bypasses pm RLS). */
async function grantPmRole(userId: string, roleKey: string): Promise<void> {
  const svc = serviceClient().schema("pm");
  const { data: role, error: roleErr } = await svc
    .from("roles")
    .select("id,scope")
    .eq("key", roleKey)
    .single();
  if (roleErr) throw roleErr;

  let subteamId: string | null = null;
  if (role!.scope === "subteam") {
    const { data: st } = await svc.from("subteams").select("id").limit(1);
    if (st && st.length > 0) {
      subteamId = st[0].id;
    } else {
      const { data: created, error } = await svc
        .from("subteams")
        .insert({ name: "Test Subteam", code: "TST", slug: "test-subteam" })
        .select()
        .single();
      if (error) throw error;
      subteamId = created!.id;
    }
  }

  const { error } = await svc
    .from("role_memberships")
    .insert({ user_id: userId, role_id: role!.id, subteam_id: subteamId });
  if (error) throw error;
}

type RoleRow = { project_id: string; team_role: string };

describe("pm.my_team_roles capability bridge", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("a capability-only Engineer (no team_memberships row) reads as engineer", async () => {
    const eng = await createTestUser(uniqueEmail("eng"));
    await grantPmRole(eng.id, "engineer");
    const projectId = await seedProject();

    const c = await signInAs(eng.email!);
    const { data, error } = await c.schema("pm").rpc("my_team_roles");
    expect(error).toBeNull();
    const rows = (data ?? []) as RoleRow[];
    expect(rows.find((r) => r.project_id === projectId)?.team_role).toBe("engineer");
  });

  it("a capability-only Viewer reads as viewer (edit stays disabled)", async () => {
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await grantPmRole(viewer.id, "viewer");
    const projectId = await seedProject();

    const c = await signInAs(viewer.email!);
    const { data } = await c.schema("pm").rpc("my_team_roles");
    const rows = (data ?? []) as RoleRow[];
    expect(rows.find((r) => r.project_id === projectId)?.team_role).toBe("viewer");
  });

  it("a legacy team_memberships row still reports its role", async () => {
    const member = await createTestUser(uniqueEmail("legacy"));
    const projectId = await seedProject();
    const svc = serviceClient().schema("pm");
    const { error } = await svc
      .from("team_memberships")
      .insert({ user_id: member.id, project_id: projectId, team_role: "admin" });
    expect(error).toBeNull();

    const c = await signInAs(member.email!);
    const { data } = await c.schema("pm").rpc("my_team_roles");
    const rows = (data ?? []) as RoleRow[];
    expect(rows.find((r) => r.project_id === projectId)?.team_role).toBe("admin");
  });

  it("a user with no grants at all gets no rows", async () => {
    const nobody = await createTestUser(uniqueEmail("nobody"));
    await seedProject();

    const c = await signInAs(nobody.email!);
    const { data, error } = await c.schema("pm").rpc("my_team_roles");
    expect(error).toBeNull();
    expect((data ?? []) as RoleRow[]).toEqual([]);
  });
});
