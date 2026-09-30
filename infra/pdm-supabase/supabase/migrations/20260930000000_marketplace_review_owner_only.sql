-- Marketplace review is owner-only for now (Nick, 2026-09-30: "make reviews me
-- only for now"). While self-serve publishing is new, every submission goes
-- through one reviewer.
--
-- Done through role data, not a hardcoded user id: `marketplace.review` is
-- removed from executive / lead / vp and stays on owner. At the time of writing
-- owner has exactly one holder. Anyone later granted owner can also review; to
-- open review back up, re-run the original grant from
-- 20260626000100_marketplace_rls.sql:
--
--   insert into pm.role_capabilities (role_id, capability_key)
--   select r.id, 'marketplace.review' from pm.roles r
--   where r.key in ('executive', 'lead', 'vp')
--   on conflict (role_id, capability_key) do nothing;
--
-- Publishing is unchanged: engineers, leads and VPs can still submit.
delete from pm.role_capabilities rc
using pm.roles r
where rc.role_id = r.id
  and rc.capability_key = 'marketplace.review'
  and r.key in ('executive', 'lead', 'vp');
