-- One-time backfill: legacy wall-marker rows for capability-only members.
--
-- Bug report a814a4a1 (2026-07-14, Srijani Saikia, lead@Battery, BLOCKER):
-- "can edit PM but cannot access Vault at all" on app v5.1.0. The v5.1.0
-- vault module gates entry on having ANY pdm.user_roles row (the audit-B1
-- probe fix ships in v5.1.1), and 20260714010000's default-deny sweep
-- removed the auto-provisioned viewer rows — so members whose only role
-- comes from Org & Access were walled out of the vault UI on the released
-- client even though every RLS gate (bridged in 20260714000000) grants them
-- full access.
--
-- Stopgap that keeps old clients working: give each user who holds
-- vault.view through a role membership, but has NO pdm.user_roles row, a
-- GLOBAL legacy 'viewer' marker. This grants nothing they don't already
-- have (vault.view ⊇ viewer; writes/admin still come from capabilities via
-- the bridge — v5.1.0's edit affordances resolve through the bridged
-- pdm_can_edit_in RPC), it only opens the old client's wall. granted_by is
-- stamped with the owner so the row reads as curated — the default-deny
-- sweep pattern (role='viewer' AND granted_by IS NULL) never matches it.
--
-- One-time by design: v5.1.1 clients use the capability-aware probe, so
-- members granted through the org tool after this date need no marker.

insert into pdm.user_roles (user_id, vault_id, role, granted_by, granted_at)
select distinct m.user_id, null::uuid, 'viewer',
       (select ur.user_id from pdm.user_roles ur where ur.role = 'owner' and ur.vault_id is null limit 1),
       now()
from pm.role_memberships m
join pm.role_capabilities rc on rc.role_id = m.role_id
where rc.capability_key = 'vault.view'
  and not exists (select 1 from pdm.user_roles ur where ur.user_id = m.user_id)
on conflict (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid))
do nothing;
