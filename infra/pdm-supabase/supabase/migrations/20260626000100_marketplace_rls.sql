-- v5.0.0 Marketplace — Sub-project B, Phase 2: RLS + publish/review capabilities.
--
-- Access model (locked with Nick 2026-06-26):
--   * PUBLISH (submit a version → lands 'pending'): anyone with engineer
--     permissions or above. Capability `marketplace.publish`, subteam-scoped,
--     granted to engineer/lead/vp (+ org-scoped executive/owner).
--   * REVIEW (approve/reject a pending version): the publisher's lead/VP (their
--     subteam) OR an executive/owner (org-wide). Capability `marketplace.review`,
--     granted to lead/vp (+ org-scoped executive/owner). Engineers cannot approve
--     their own submissions.
--   * INSTALL: any signed-in member, of an APPROVED version only.
-- Resolution rides the existing RBAC `pm.has_capability(uid, cap, stid)`: an
-- org-scoped membership (subteam_id IS NULL) satisfies any `stid`, so exec/owner
-- approve anywhere while a lead/vp only satisfies their own subteam.
--
-- DEPENDS ON the org-roles initiative being live (role_memberships seeded). Until
-- it is, these capabilities resolve to nobody — the same gating the rest of the
-- RBAC waits on. Writes are all via SECURITY DEFINER RPCs; only SELECT is exposed.

-- ---------------------------------------------------------------------------
-- 1. Capability catalog entries. (Owner/Executive do NOT auto-inherit new caps
--    — the 20260617 seeding only covered caps that existed then — so we grant
--    them explicitly below.)
-- ---------------------------------------------------------------------------
insert into pm.capabilities (key, label, description, scope) values
  ('marketplace.publish', 'Marketplace: publish', 'Submit a plugin version for review',          'subteam'),
  ('marketplace.review',  'Marketplace: review',  'Approve or reject a submitted plugin version', 'subteam')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

-- ---------------------------------------------------------------------------
-- 2. Grant the caps to the seeded roles (idempotent).
-- ---------------------------------------------------------------------------
insert into pm.role_capabilities (role_id, capability_key)
select r.id, c.key
from pm.roles r
join pm.capabilities c on c.key in ('marketplace.publish', 'marketplace.review')
where (
  (c.key = 'marketplace.publish' and r.key in ('owner','executive','lead','vp','engineer'))
  or (c.key = 'marketplace.review'  and r.key in ('owner','executive','lead','vp'))
)
on conflict (role_id, capability_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. RLS. Reads are policy-gated; all writes go through the RPCs (default-deny on
--    direct INSERT/UPDATE/DELETE since no write policy exists, and the RPCs are
--    SECURITY DEFINER so they bypass RLS intentionally).
-- ---------------------------------------------------------------------------

-- plugins: discoverable once approved (org-wide); pending/rejected rows visible
-- only to the owning subteam's publishers and to reviewers.
alter table marketplace.plugins enable row level security;
drop policy if exists plugins_select on marketplace.plugins;
create policy plugins_select on marketplace.plugins
  for select to authenticated
  using (
    exists (
      select 1 from marketplace.plugin_versions v
      where v.plugin_id = id and v.review_status = 'approved'
    )
    or pm.has_capability(auth.uid(), 'marketplace.publish', subteam)
    or pm.has_capability(auth.uid(), 'marketplace.review',  subteam)
  );

-- plugin_versions: approved versions are visible to everyone; non-approved
-- versions only to the owning subteam's publishers + reviewers.
alter table marketplace.plugin_versions enable row level security;
drop policy if exists plugin_versions_select on marketplace.plugin_versions;
create policy plugin_versions_select on marketplace.plugin_versions
  for select to authenticated
  using (
    review_status = 'approved'
    or pm.has_capability(auth.uid(), 'marketplace.publish', marketplace.plugin_subteam(plugin_id))
    or pm.has_capability(auth.uid(), 'marketplace.review',  marketplace.plugin_subteam(plugin_id))
  );

-- plugin_installs: a user sees only their own installs (writes are via the
-- install/uninstall RPCs, which additionally enforce "approved only").
alter table marketplace.plugin_installs enable row level security;
drop policy if exists plugin_installs_select_self on marketplace.plugin_installs;
create policy plugin_installs_select_self on marketplace.plugin_installs
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Table grants (RLS still filters every row).
-- ---------------------------------------------------------------------------
grant select on marketplace.plugins,
                marketplace.plugin_versions,
                marketplace.plugin_installs
  to authenticated;
