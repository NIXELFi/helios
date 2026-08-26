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

  it("grants execute to authenticated for every function it defines", () => {
    const defined = [...SQL.matchAll(/create or replace function marketplace\.(\w+)/g)].map(
      (m) => m[1],
    );
    for (const fn of defined) {
      expect(SQL).toMatch(new RegExp(`grant execute on function marketplace\\.${fn}\\(`));
    }
  });

  it("re-checks the publish capability inside every author-side RPC", () => {
    for (const fn of ["withdraw_plugin_version", "yank_plugin_version", "set_plugin_recommended"]) {
      expect(bodyOf(fn)).toMatch(/pm\.has_capability\(v_uid, 'marketplace\.publish'/);
    }
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
