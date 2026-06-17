-- Phase 1b: access-preserving seed of pm.role_memberships from the CURRENT
-- (global) Vault roles. Owner decision 2026-06-17:
--   owner  -> Owner
--   admin  -> Lead      (owner will bump some to VP later)
--   editor -> Engineer
--   viewer -> Engineer
-- All ORG-SCOPED (subteam_id NULL = applies everywhere), because the existing
-- Vault roles are global (vault_id IS NULL) -- this preserves current access
-- without lockout. The owner refines to VP / per-subteam / Executive via the
-- admin UI. Additive + reversible (delete from pm.role_memberships) and NOT yet
-- enforced -- the RLS cutover is a separate, gated step. Idempotent.

insert into pm.role_memberships (user_id, role_id, subteam_id, granted_by)
select ur.user_id,
       r.id,
       null,
       (select o.user_id from pdm.user_roles o where o.role = 'owner' and o.vault_id is null limit 1)
from pdm.user_roles ur
join pm.roles r on r.key = case ur.role
  when 'owner'  then 'owner'
  when 'admin'  then 'lead'
  when 'editor' then 'engineer'
  when 'viewer' then 'engineer'
end
where ur.vault_id is null
  and ur.role in ('owner', 'admin', 'editor', 'viewer')
on conflict do nothing;
