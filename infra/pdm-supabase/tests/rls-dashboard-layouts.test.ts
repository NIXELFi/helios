import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anonClient,
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/**
 * 20260817000000: shared dashboard layouts. One row per scope in
 * pm.dashboard_layouts; reads for org members, writes only through the
 * pm.manage_dashboard capability (Lead/VP of that subteam, Executive/Owner
 * org-wide), saves via the pm.save_dashboard_layout upsert RPC (SECURITY
 * INVOKER — RLS is the authority on both its insert and conflict-update
 * paths).
 */

const CFG_A = { version: 2, tabs: [{ id: "t1", name: "A", widgets: [] }] };
const CFG_B = { version: 2, tabs: [{ id: "t2", name: "B", widgets: [] }] };

async function makeSubteam(slugHint: string): Promise<string> {
  const svc = serviceClient().schema("pm");
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { data, error } = await svc
    .from("subteams")
    .insert({ name: `Sub ${slugHint} ${suffix}`, code: slugHint.slice(0, 3).toUpperCase(), slug: `${slugHint}-${suffix}` })
    .select()
    .single();
  if (error) throw error;
  return data!.id as string;
}

/** Grants a pm role membership directly (service role bypasses pm RLS). */
async function grantPmRole(userId: string, roleKey: string, subteamId: string | null): Promise<void> {
  const svc = serviceClient().schema("pm");
  const { data: role, error: roleErr } = await svc.from("roles").select("id").eq("key", roleKey).single();
  if (roleErr) throw roleErr;
  const { error } = await svc
    .from("role_memberships")
    .insert({ user_id: userId, role_id: role!.id, subteam_id: subteamId });
  if (error) throw error;
}

async function layoutRows(subteamId: string | null) {
  const svc = serviceClient().schema("pm");
  let q = svc.from("dashboard_layouts").select("id,subteam_id,config,updated_by");
  q = subteamId === null ? q.is("subteam_id", null) : q.eq("subteam_id", subteamId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

describe("pm.dashboard_layouts RLS + save_dashboard_layout RPC", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => {
    // Layout rows for NULL scope collide across tests via the scope-unique
    // index; clear them so each test starts from an empty table.
    await serviceClient().schema("pm").from("dashboard_layouts").delete().not("id", "is", null);
    await resetAuthUsers();
  });

  it("anon can neither read layouts nor call the save RPC", async () => {
    const c = anonClient();
    const { data, error: selErr } = await c.schema("pm").from("dashboard_layouts").select("id").limit(1);
    // Either an explicit denial or RLS-filter-to-zero counts; success with rows is a hole.
    if (selErr === null) expect(data ?? []).toHaveLength(0);
    const { error: rpcErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: null, cfg: CFG_A });
    expect(rpcErr).not.toBeNull();
    expect(await layoutRows(null)).toHaveLength(0);
  });

  it("a subteam Lead can create then update their subteam's layout (insert + conflict paths), and org members can read it", async () => {
    const st = await makeSubteam("aero");
    const lead = await createTestUser(uniqueEmail("lead"));
    await grantPmRole(lead.id, "lead", st);
    const viewer = await createTestUser(uniqueEmail("viewer"));
    await setRole(viewer.id, "viewer"); // org member via legacy pdm role

    const c = await signInAs(lead.email!);
    // Insert path.
    const { error: e1 } = await c.schema("pm").rpc("save_dashboard_layout", { stid: st, cfg: CFG_A });
    expect(e1).toBeNull();
    // Conflict-update path: same scope again must update the ONE row, not add.
    const { error: e2 } = await c.schema("pm").rpc("save_dashboard_layout", { stid: st, cfg: CFG_B });
    expect(e2).toBeNull();
    const rows = await layoutRows(st);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.config as typeof CFG_B).tabs[0]!.name).toBe("B");
    expect(rows[0]!.updated_by).toBe(lead.id);

    const v = await signInAs(viewer.email!);
    const { data: seen, error: readErr } = await v.schema("pm").from("dashboard_layouts").select("id").eq("subteam_id", st);
    expect(readErr).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("a Lead of subteam A cannot write subteam B's layout nor the all-team layout", async () => {
    const stA = await makeSubteam("aero");
    const stB = await makeSubteam("chassis");
    const lead = await createTestUser(uniqueEmail("lead"));
    await grantPmRole(lead.id, "lead", stA);

    const c = await signInAs(lead.email!);
    const { error: crossErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: stB, cfg: CFG_A });
    expect(crossErr).not.toBeNull();
    const { error: orgErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: null, cfg: CFG_A });
    expect(orgErr).not.toBeNull();
    expect(await layoutRows(stB)).toHaveLength(0);
    expect(await layoutRows(null)).toHaveLength(0);

    // The conflict-UPDATE path is also gated: seed B's row as service, then
    // try to overwrite it as the A lead.
    const svc = serviceClient().schema("pm");
    await svc.from("dashboard_layouts").insert({ subteam_id: stB, config: CFG_A });
    const { error: updErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: stB, cfg: CFG_B });
    expect(updErr).not.toBeNull();
    const rows = await layoutRows(stB);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.config as typeof CFG_A).tabs[0]!.name).toBe("A");
  });

  it("an Executive (org-scoped) can write the all-team layout and any subteam's", async () => {
    const st = await makeSubteam("aero");
    const exec = await createTestUser(uniqueEmail("exec"));
    await grantPmRole(exec.id, "executive", null);

    const c = await signInAs(exec.email!);
    const { error: orgErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: null, cfg: CFG_A });
    expect(orgErr).toBeNull();
    const { error: stErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: st, cfg: CFG_B });
    expect(stErr).toBeNull();
    expect(await layoutRows(null)).toHaveLength(1);
    expect(await layoutRows(st)).toHaveLength(1);
  });

  it("an Engineer (no manage_dashboard) cannot save anywhere", async () => {
    const st = await makeSubteam("aero");
    const eng = await createTestUser(uniqueEmail("eng"));
    await grantPmRole(eng.id, "engineer", st);

    const c = await signInAs(eng.email!);
    const { error: stErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: st, cfg: CFG_A });
    expect(stErr).not.toBeNull();
    const { error: orgErr } = await c.schema("pm").rpc("save_dashboard_layout", { stid: null, cfg: CFG_A });
    expect(orgErr).not.toBeNull();
    expect(await layoutRows(st)).toHaveLength(0);
    expect(await layoutRows(null)).toHaveLength(0);
  });

  it("a role-less account reads nothing (org default-deny)", async () => {
    const st = await makeSubteam("aero");
    const svc = serviceClient().schema("pm");
    await svc.from("dashboard_layouts").insert({ subteam_id: st, config: CFG_A });

    const nobody = await createTestUser(uniqueEmail("nobody"));
    const c = await signInAs(nobody.email!);
    const { data } = await c.schema("pm").from("dashboard_layouts").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});
