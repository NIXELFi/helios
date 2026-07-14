-- Keep old clients working for FUTURE org-tool grants (companion to the
-- one-time backfill in 20260714050000, which only covered existing members).
--
-- Until the whole fleet is on >= v5.1.1 (whose vault wall uses the
-- capability-aware pdm_has_vault_access probe), a v5.1.0 client refuses to
-- open the vault for any account with zero pdm.user_roles rows. Without
-- this trigger, every member onboarded through Org & Access after today
-- would re-hit bug report a814a4a1 until they updated the app.
--
-- On each role grant: if the role carries vault.view and the user has no
-- legacy row at all, stamp the same global 'viewer' marker the backfill
-- used (granted_by = owner → curated shape, never matched by the
-- default-deny sweep pattern). Grants nothing beyond what the capability
-- already provides; writes/admin resolve through the capability bridge.
-- Error-swallowing so a marker hiccup can never block the actual grant.
--
-- TRANSITIONAL: drop trigger + function once the fleet is on v5.1.1+
-- (client-side the marker is then redundant; permissions never read it
-- beyond baseline membership, which vault.view already implies).

create or replace function pdm.stamp_wall_marker_on_grant()
returns trigger
language plpgsql
security definer
set search_path = pdm, pm, public
as $$
begin
  if exists (
       select 1 from pm.role_capabilities rc
       where rc.role_id = new.role_id and rc.capability_key = 'vault.view'
     )
     and not exists (select 1 from pdm.user_roles ur where ur.user_id = new.user_id)
  then
    insert into pdm.user_roles (user_id, vault_id, role, granted_by, granted_at)
    values (
      new.user_id, null, 'viewer',
      (select ur.user_id from pdm.user_roles ur where ur.role = 'owner' and ur.vault_id is null limit 1),
      now()
    )
    on conflict (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do nothing;
  end if;
  return new;
exception
  when others then
    raise warning 'pdm.stamp_wall_marker_on_grant: failed for % : %', new.user_id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_role_memberships_wall_marker on pm.role_memberships;
create trigger trg_role_memberships_wall_marker
  after insert on pm.role_memberships
  for each row execute function pdm.stamp_wall_marker_on_grant();
