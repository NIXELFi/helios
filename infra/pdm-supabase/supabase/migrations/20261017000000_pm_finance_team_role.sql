-- Finance team role (PR #59 follow-up).
--
-- The CFO has helpers who are not execs. Until now there was no role for
-- them: finance.view / finance.edit sat only on the exec roles, so the only
-- way to let them see the books was to make them execs, which also hands
-- them approvals and everything else.
--
-- An org-wide role with just the money capabilities: see and keep the books
-- (finance.view, finance.edit), see every part and record orders, tracking
-- and deliveries (purchasing.view, purchasing.order). NOT purchasing.approve:
-- approvals stay with the execs, and purchasing.is_exec() (which gates the
-- exec-only Agora surfaces) is defined as holding purchasing.approve, so this
-- role is not an exec anywhere. NOT purchasing.request either: it is a
-- subteam-scoped capability and the finance team does not ask for parts.
--
-- Granting it is the usual pm.grant_role('finance_team') from Admin (needs
-- org.grant_roles; the Owner, President, COO and CFO hold the whole
-- capability set, so any of them can grant it).
--
-- The signup list already offers "Finance" (pdm.subteams row 10), so no
-- change there.

insert into pm.roles (key, label, tag, scope, is_system, sort_order)
values ('finance_team', 'Finance team', '#60A5FA', 'org', false, 6)
on conflict (key) do update set label = excluded.label, scope = excluded.scope, updated_at = now();

insert into pm.role_capabilities (role_id, capability_key)
select r.id, c.key
from pm.roles r
join pm.capabilities c on c.key in ('finance.view', 'finance.edit', 'purchasing.view', 'purchasing.order')
where r.key = 'finance_team'
on conflict do nothing;
