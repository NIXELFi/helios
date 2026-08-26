import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  signInAs,
  uniqueEmail,
} from "./setup.js";

/**
 * 20260826010000: the author-facing half of the marketplace.
 *
 * Covers the ACLs the UI relies on but must never be the authority for:
 * withdraw / yank / recommend require `marketplace.publish` on the plugin's
 * OWNING subteam, the two new states drop out of distribution, and reviewer
 * preview installs are gated on `marketplace.review`, restricted to pending
 * versions, and invisible to Browse.
 *
 * Requires a live database (see scripts/test-or-skip.cjs) — it does not run on
 * machines without Supabase. The shape of the migration is separately asserted,
 * without a database, in marketplace-publish-ui.structure.test.ts.
 */

const suffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makeSubteam(slugHint: string): Promise<string> {
  const svc = serviceClient().schema("pm");
  const s = suffix();
  const { data, error } = await svc
    .from("subteams")
    .insert({
      name: `Sub ${slugHint} ${s}`,
      code: `${slugHint.slice(0, 3).toUpperCase()}-${s}`,
      slug: `${slugHint}-${s}`,
    })
    .select()
    .single();
  if (error) throw error;
  return data!.id as string;
}

async function grantPmRole(userId: string, roleKey: string, subteamId: string | null): Promise<void> {
  const svc = serviceClient().schema("pm");
  const { data: role, error: roleErr } = await svc
    .from("roles")
    .select("id")
    .eq("key", roleKey)
    .single();
  if (roleErr) throw roleErr;
  const { error } = await svc
    .from("role_memberships")
    .insert({ user_id: userId, role_id: role!.id, subteam_id: subteamId });
  if (error) throw error;
}

/** Insert a plugin + one version directly (service role bypasses RLS). Publishing
 *  through the RPC would drag in signing; these tests are about ACLs, not crypto. */
async function seedPlugin(opts: {
  subteam: string | null;
  createdBy: string;
  version: string;
  status: "pending" | "approved" | "rejected";
  id?: string;
}): Promise<string> {
  const svc = serviceClient().schema("marketplace");
  const pluginId = opts.id ?? `test.plugin-${suffix()}`;
  const { error: pErr } = await svc.from("plugins").upsert({
    id: pluginId,
    name: `Test ${pluginId}`,
    subteam: opts.subteam,
    created_by: opts.createdBy,
    latest_version: opts.status === "approved" ? opts.version : null,
  });
  if (pErr) throw pErr;
  const { error: vErr } = await svc.from("plugin_versions").insert({
    plugin_id: pluginId,
    version: opts.version,
    manifest: {
      format: 1,
      id: pluginId,
      name: `Test ${pluginId}`,
      version: opts.version,
      entry: "dist/index.html",
      sdk: "^1.0.0",
      permissions: [],
    },
    permissions: [],
    bundle_sha256: "a".repeat(64),
    bundle_bytes: 1024,
    review_status: opts.status,
    published_by: opts.createdBy,
  });
  if (vErr) throw vErr;
  return pluginId;
}

async function versionStatus(pluginId: string, version: string): Promise<string> {
  const { data, error } = await serviceClient()
    .schema("marketplace")
    .from("plugin_versions")
    .select("review_status")
    .eq("plugin_id", pluginId)
    .eq("version", version)
    .single();
  if (error) throw error;
  return data!.review_status as string;
}

describe("marketplace — author-side management RPCs", () => {
  beforeEach(async () => {
    await resetAuthUsers();
  });
  afterEach(async () => {
    await resetAuthUsers();
  });

  it("withdraws a pending submission for a publisher on the owning subteam", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    await grantPmRole(author.id, "engineer", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "pending",
    });

    const client = await signInAs(author.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("withdraw_plugin_version", { p_plugin_id: pluginId, p_version: "1.0.0" });

    expect(error).toBeNull();
    expect(await versionStatus(pluginId, "1.0.0")).toBe("withdrawn");
  });

  it("refuses a withdraw from a publisher on a DIFFERENT subteam", async () => {
    const subA = await makeSubteam("aero");
    const subB = await makeSubteam("chassis");
    const author = await createTestUser(uniqueEmail("author"));
    const outsider = await createTestUser(uniqueEmail("outsider"));
    await grantPmRole(outsider.id, "engineer", subB);
    const pluginId = await seedPlugin({
      subteam: subA,
      createdBy: author.id,
      version: "1.0.0",
      status: "pending",
    });

    const client = await signInAs(outsider.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("withdraw_plugin_version", { p_plugin_id: pluginId, p_version: "1.0.0" });

    expect(error?.message).toMatch(/insufficient privilege/i);
    expect(await versionStatus(pluginId, "1.0.0")).toBe("pending");
  });

  it("refuses to withdraw an already-approved version", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    await grantPmRole(author.id, "engineer", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "approved",
    });

    const client = await signInAs(author.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("withdraw_plugin_version", { p_plugin_id: pluginId, p_version: "1.0.0" });

    expect(error?.message).toMatch(/only a pending submission can be withdrawn/i);
  });

  it("yanks an approved version and falls latest_version back to the previous one", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    await grantPmRole(author.id, "engineer", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "approved",
    });
    // A newer approved version, published later.
    const svc = serviceClient().schema("marketplace");
    await svc.from("plugin_versions").insert({
      plugin_id: pluginId,
      version: "1.1.0",
      manifest: { format: 1, id: pluginId, name: "t", version: "1.1.0", entry: "dist/index.html", sdk: "^1.0.0", permissions: [] },
      permissions: [],
      bundle_sha256: "b".repeat(64),
      bundle_bytes: 2048,
      review_status: "approved",
      published_by: author.id,
      published_at: new Date(Date.now() + 1000).toISOString(),
    });
    await svc.from("plugins").update({ latest_version: "1.1.0" }).eq("id", pluginId);

    const client = await signInAs(author.email!);
    const { error } = await client.schema("marketplace").rpc("yank_plugin_version", {
      p_plugin_id: pluginId,
      p_version: "1.1.0",
      p_reason: "bad build",
    });

    expect(error).toBeNull();
    expect(await versionStatus(pluginId, "1.1.0")).toBe("yanked");
    const { data } = await svc.from("plugins").select("latest_version").eq("id", pluginId).single();
    expect(data!.latest_version).toBe("1.0.0");
  });

  it("refuses to yank a pending version", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    await grantPmRole(author.id, "engineer", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "pending",
    });

    const client = await signInAs(author.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("yank_plugin_version", { p_plugin_id: pluginId, p_version: "1.0.0" });

    expect(error?.message).toMatch(/only an approved version can be yanked/i);
  });

  it("drops a yanked version out of distribution entirely", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    await grantPmRole(author.id, "engineer", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "approved",
    });

    const client = await signInAs(author.email!);
    await client
      .schema("marketplace")
      .rpc("yank_plugin_version", { p_plugin_id: pluginId, p_version: "1.0.0" });

    const { data: listed } = await client.schema("marketplace").rpc("list_available_plugins");
    expect((listed ?? []).some((r: { id: string }) => r.id === pluginId)).toBe(false);

    const { error: installErr } = await client
      .schema("marketplace")
      .rpc("install_plugin", { p_plugin_id: pluginId, p_version: "1.0.0" });
    expect(installErr?.message).toMatch(/not installable/i);
  });

  it("toggles is_recommended only for a publisher on the owning subteam", async () => {
    const subA = await makeSubteam("aero");
    const subB = await makeSubteam("chassis");
    const author = await createTestUser(uniqueEmail("author"));
    const outsider = await createTestUser(uniqueEmail("outsider"));
    await grantPmRole(author.id, "engineer", subA);
    await grantPmRole(outsider.id, "engineer", subB);
    const pluginId = await seedPlugin({
      subteam: subA,
      createdBy: author.id,
      version: "1.0.0",
      status: "approved",
    });

    const bad = await signInAs(outsider.email!);
    const { error: badErr } = await bad
      .schema("marketplace")
      .rpc("set_plugin_recommended", { p_plugin_id: pluginId, p_value: true });
    expect(badErr?.message).toMatch(/insufficient privilege/i);

    const good = await signInAs(author.email!);
    const { error: goodErr } = await good
      .schema("marketplace")
      .rpc("set_plugin_recommended", { p_plugin_id: pluginId, p_value: true });
    expect(goodErr).toBeNull();

    const { data } = await serviceClient()
      .schema("marketplace")
      .from("plugins")
      .select("is_recommended")
      .eq("id", pluginId)
      .single();
    expect(data!.is_recommended).toBe(true);
  });

  it("lists the caller's own plugins including non-approved versions", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    await grantPmRole(author.id, "engineer", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "0.1.0",
      status: "pending",
    });

    const client = await signInAs(author.email!);
    const { data, error } = await client.schema("marketplace").rpc("my_published_plugins");
    expect(error).toBeNull();
    const mine = (data ?? []).filter((r: { plugin_id: string }) => r.plugin_id === pluginId);
    expect(mine).toHaveLength(1);
    expect(mine[0].review_status).toBe("pending");
  });
});

describe("marketplace — reviewer preview installs", () => {
  beforeEach(async () => {
    await resetAuthUsers();
  });
  afterEach(async () => {
    await resetAuthUsers();
  });

  it("lets a reviewer install a pending version, flagged as a preview", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    const reviewer = await createTestUser(uniqueEmail("reviewer"));
    await grantPmRole(reviewer.id, "lead", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "pending",
    });

    const client = await signInAs(reviewer.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("install_plugin_for_review", { p_plugin_id: pluginId, p_version: "1.0.0" });
    expect(error).toBeNull();

    const { data } = await serviceClient()
      .schema("marketplace")
      .from("plugin_installs")
      .select("is_preview,installed_version")
      .eq("user_id", reviewer.id)
      .eq("plugin_id", pluginId)
      .single();
    expect(data!.is_preview).toBe(true);
    expect(data!.installed_version).toBe("1.0.0");
  });

  it("refuses a preview install from someone who cannot review that subteam", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    const engineer = await createTestUser(uniqueEmail("engineer"));
    await grantPmRole(engineer.id, "engineer", sub); // publish, but not review
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "pending",
    });

    const client = await signInAs(engineer.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("install_plugin_for_review", { p_plugin_id: pluginId, p_version: "1.0.0" });
    expect(error?.message).toMatch(/insufficient privilege to preview/i);
  });

  it("refuses a preview install of an already-approved version", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    const reviewer = await createTestUser(uniqueEmail("reviewer"));
    await grantPmRole(reviewer.id, "lead", sub);
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "approved",
    });

    const client = await signInAs(reviewer.email!);
    const { error } = await client
      .schema("marketplace")
      .rpc("install_plugin_for_review", { p_plugin_id: pluginId, p_version: "1.0.0" });
    expect(error?.message).toMatch(/only a pending version can be previewed/i);
  });

  it("keeps a preview install out of the caller's Browse installed_version", async () => {
    const sub = await makeSubteam("aero");
    const author = await createTestUser(uniqueEmail("author"));
    const reviewer = await createTestUser(uniqueEmail("reviewer"));
    await grantPmRole(reviewer.id, "lead", sub);
    // An approved 1.0.0 makes the plugin visible in Browse; 1.1.0 is pending.
    const pluginId = await seedPlugin({
      subteam: sub,
      createdBy: author.id,
      version: "1.0.0",
      status: "approved",
    });
    await serviceClient()
      .schema("marketplace")
      .from("plugin_versions")
      .insert({
        plugin_id: pluginId,
        version: "1.1.0",
        manifest: { format: 1, id: pluginId, name: "t", version: "1.1.0", entry: "dist/index.html", sdk: "^1.0.0", permissions: [] },
        permissions: [],
        bundle_sha256: "c".repeat(64),
        bundle_bytes: 2048,
        review_status: "pending",
        published_by: author.id,
      });

    const client = await signInAs(reviewer.email!);
    await client
      .schema("marketplace")
      .rpc("install_plugin_for_review", { p_plugin_id: pluginId, p_version: "1.1.0" });

    const { data } = await client.schema("marketplace").rpc("list_available_plugins");
    const row = (data ?? []).find((r: { id: string }) => r.id === pluginId);
    expect(row).toBeTruthy();
    // The preview must NOT read as "you have 1.1.0 installed".
    expect(row.installed_version).toBeNull();
  });
});
