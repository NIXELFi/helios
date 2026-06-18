import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

// Regression for the v4.4.6 fix to pdm.admin_delete_user: it must detach the
// NO-ACTION FKs added after it shipped (pm.task_owners.created_by,
// pm.task_links.created_by) before deleting auth.users, so deleting a user who
// created a task link / owner row no longer FK-violates and rolls back.
//
// NOTE: support.reports.reporter_id is the third such FK, but the `support`
// schema is not exposed to the test PostgREST API (see supabase/config.toml),
// so this test covers the two pm-schema paths. The migration reassigns
// reporter_id to the deleting admin on the same code path.

const pm = (c: any) => c.schema("pm");

/** Seeds a project + subteam (service role, bypasses RLS) and returns ids. */
async function seedPmProject(): Promise<{ projectId: string; subteamId: string }> {
  const svc = serviceClient();
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { data: proj, error: pErr } = await pm(svc)
    .from("projects")
    .insert({ name: `P-${tag}`, car_year: 2026, car_code: `SDMX${tag}`.slice(0, 12) })
    .select().single();
  if (pErr) throw new Error(`seed project: ${pErr.message}`);
  const { data: st, error: sErr } = await pm(svc)
    .from("subteams")
    .insert({ name: `S-${tag}`, code: `S${tag}`.slice(0, 8), slug: `s-${tag}` })
    .select().single();
  if (sErr) throw new Error(`seed subteam: ${sErr.message}`);
  return { projectId: proj!.id, subteamId: st!.id };
}

describe("pdm.admin_delete_user() — newer NO-ACTION FK detach (v4.4.6)", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("deletes a user who created a task_owner and task_link row", async () => {
    const svc = serviceClient();
    const owner = await createTestUser(uniqueEmail("owner"));
    await setRole(owner.id, "owner"); // the deleting admin (owner can delete admins/users)
    const victim = await createTestUser(uniqueEmail("victim"));
    await setRole(victim.id, "editor");

    const { projectId, subteamId } = await seedPmProject();

    // A task the victim created + co-owns + linked.
    const { data: task, error: tErr } = await pm(svc).from("tasks")
      .insert({ project_id: projectId, subteam_id: subteamId, title: "T", created_by: victim.id })
      .select().single();
    if (tErr) throw new Error(`seed task: ${tErr.message}`);

    // task_owners.created_by = victim (NO-ACTION FK the old function missed).
    const { error: oErr } = await pm(svc).from("task_owners")
      .insert({ task_id: task!.id, owner_id: owner.id, is_primary: true, created_by: victim.id });
    if (oErr) throw new Error(`seed task_owner: ${oErr.message}`);

    // task_links.created_by = victim (NO-ACTION FK the old function missed).
    const { error: lErr } = await pm(svc).from("task_links")
      .insert({ task_id: task!.id, url: "https://example.com/doc", label: "spec", created_by: victim.id });
    if (lErr) throw new Error(`seed task_link: ${lErr.message}`);

    try {
      // Delete the victim as the signed-in owner. Pre-fix this rolled back with
      // an FK violation on task_owners/task_links created_by.
      const oc = await signInAs(owner.email!);
      const { error } = await oc.rpc("pdm_admin_delete_user", { p_target: victim.id });
      expect(error).toBeNull();

      // Auth user is gone.
      const { data: list } = await svc.auth.admin.listUsers();
      expect(list.users.find((u) => u.id === victim.id)).toBeUndefined();

      // The detached rows survive with created_by nulled.
      const { data: links } = await pm(svc).from("task_links").select("created_by").eq("task_id", task!.id);
      expect(links!.every((r: any) => r.created_by === null)).toBe(true);
    } finally {
      // Clean the pm rows this test seeded so the afterEach auth wipe doesn't
      // FK-violate against the surviving owner via task created_by/owner_id.
      await pm(svc).from("projects").delete().eq("id", projectId);
      await pm(svc).from("subteams").delete().eq("id", subteamId);
    }
  });
});
