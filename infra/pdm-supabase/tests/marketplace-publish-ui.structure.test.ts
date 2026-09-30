import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Shape assertions over the publish-UI migration. These guard the properties the
// app depends on but cannot observe locally (no Docker -> no local Supabase, so
// the live RLS suite in rls-marketplace-publish.test.ts only runs in CI). They
// are cheap and they catch the failure modes that would be silent: a capability
// check dropped from an RPC, a mutable search_path, a preview install leaking
// into Browse.
const SQL = readFileSync(
  fileURLToPath(
    new URL("../supabase/migrations/20260826010000_marketplace_publish_ui.sql", import.meta.url),
  ),
  "utf8",
);

/** The body of one function definition: from its header to its grant. */
function bodyOf(fn: string): string {
  const after = SQL.split(`function marketplace.${fn}`)[1];
  expect(after, `marketplace.${fn} is not defined`).toBeTruthy();
  return after.split("grant execute")[0];
}

describe("marketplace publish-UI migration", () => {
  it("widens review_status to include withdrawn and yanked", () => {
    expect(SQL).toMatch(
      /review_status in \('pending','approved','rejected','withdrawn','yanked'\)/,
    );
  });

  it("drops the old status constraint by lookup, not by assumed name", () => {
    // A hardcoded constraint name that does not match would silently leave the
    // three-state check in place and every withdraw/yank would fail at runtime.
    expect(SQL).toMatch(/from pg_constraint/);
    expect(SQL).toMatch(/pg_get_constraintdef\(con\.oid\) ilike '%review_status%'/);
  });

  it("adds an is_preview flag to plugin_installs", () => {
    expect(SQL).toMatch(/add column if not exists is_preview boolean not null default false/);
  });

  it.each([
    "my_published_plugins",
    "withdraw_plugin_version",
    "yank_plugin_version",
    "set_plugin_recommended",
    "install_plugin_for_review",
  ])("defines marketplace.%s", (fn) => {
    expect(SQL).toMatch(new RegExp(`create or replace function marketplace\\.${fn}`));
  });

  it("pins search_path on every function it defines", () => {
    const defs = SQL.split(/create or replace function/).slice(1);
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) expect(d).toMatch(/set search_path =/);
  });

  // Helpers only SECURITY DEFINER functions may call, as the owner.
  const INTERNAL = ["validate_manifest", "can_manage_version"];
  const finalGrant = () => SQL.split("grant execute on function\n").pop()!;

  it("grants execute to authenticated for every API function it defines", () => {
    const defined = [...SQL.matchAll(/create or replace function marketplace\.(\w+)/g)]
      .map((m) => m[1])
      .filter((fn) => !INTERNAL.includes(fn));
    for (const fn of defined) {
      expect(finalGrant(), `${fn} missing from the final grant`).toMatch(
        new RegExp(`marketplace\\.${fn}\\(`),
      );
    }
  });

  it("strips the default PUBLIC execute grant from the whole schema", () => {
    expect(SQL).toMatch(/revoke execute on all functions in schema marketplace from public, anon;/);
    expect(SQL).toMatch(
      /alter default privileges in schema marketplace revoke execute on functions from public;/,
    );
  });

  it.each([
    ["sign_message", "sign_message\\(bytea\\)"],
    ["validate_manifest", "validate_manifest\\(jsonb\\)"],
    ["can_manage_version", "can_manage_version\\(uuid, text, text\\)"],
  ])("never grants the internal helper %s to authenticated", (_name, sig) => {
    expect(SQL).toMatch(new RegExp(`revoke execute on function marketplace\\.${sig} from authenticated`));
    expect(finalGrant()).not.toMatch(new RegExp(`marketplace\\.${sig}`));
  });

  it("lets only the author or a reviewer withdraw or yank", () => {
    for (const fn of ["withdraw_plugin_version", "yank_plugin_version"]) {
      expect(bodyOf(fn)).toMatch(/marketplace\.can_manage_version\(v_uid, p_plugin_id, p_version\)/);
    }
    const helper = bodyOf("can_manage_version");
    expect(helper).toMatch(/pv\.published_by = p_uid/);
    expect(helper).toMatch(/'marketplace\.review'/);
  });

  it("makes recommending a lead/VP decision", () => {
    expect(bodyOf("set_plugin_recommended")).toMatch(
      /pm\.has_capability\(v_uid, 'marketplace\.review'/,
    );
  });

  it("only reviews pending versions, under a row lock", () => {
    const body = bodyOf("review_plugin_version");
    expect(body).toMatch(/for update/);
    expect(body).toMatch(/v_status <> 'pending'/);
    expect(body).toMatch(/you cannot approve your own submission/);
  });

  it("clears is_preview on every normal install", () => {
    expect(bodyOf("install_plugin(")).toMatch(/is_preview\s*=\s*false/);
  });

  it("refuses a preview that would silently replace a real install", () => {
    const body = bodyOf("install_plugin_for_review");
    expect(body).toMatch(/p_replace_install/);
    expect(body).toMatch(/PREVIEW_REPLACES_INSTALL/);
  });

  it("builds Installed from the caller's own install rows", () => {
    const body = bodyOf("my_installed_plugins");
    expect(body).toMatch(/from marketplace\.plugin_installs i/);
    expect(body).toMatch(/i\.user_id = auth\.uid\(\)/);
    expect(body).toMatch(/left join marketplace\.plugin_versions/);
  });

  it("validates permissions against the SDK catalog", () => {
    const body = bodyOf("validate_manifest");
    expect(body).toMatch(/not in \('file\.read', 'file\.write', 'storage', 'engine:matlab'\)/);
    expect(body).toMatch(/%\(2e\|2f\|5c\)/);
  });

  it("caps the plugins bucket at 25 MiB", () => {
    expect(SQL).toMatch(/file_size_limit = 26214400/);
  });

  it("requires the review capability for a reviewer preview install", () => {
    expect(bodyOf("install_plugin_for_review")).toMatch(
      /pm\.has_capability\(v_uid, 'marketplace\.review'/,
    );
  });

  it("lets a preview install only ever target a pending version", () => {
    const body = bodyOf("install_plugin_for_review");
    expect(body).toMatch(/review_status <> 'pending'/);
    expect(body).toMatch(/is_preview\s*=\s*true|is_preview\b[^)]*\)\s*values/);
  });

  it("keeps preview installs out of the Browse installed_version", () => {
    expect(bodyOf("list_available_plugins")).toMatch(/inst\.is_preview\s*=\s*false/);
  });

  it("only withdraws pending versions and only yanks approved ones", () => {
    expect(bodyOf("withdraw_plugin_version")).toMatch(/<> 'pending'/);
    expect(bodyOf("yank_plugin_version")).toMatch(/<> 'approved'/);
  });

  it("recomputes latest_version after a yank the same way review does", () => {
    const body = bodyOf("yank_plugin_version");
    expect(body).toMatch(/set latest_version = \(/);
    expect(body).toMatch(/review_status = 'approved'\s*\n?\s*order by pv\.published_at desc limit 1/);
  });
});
