-- v4.4.6 fix: RBAC NULL subteam_id privilege over-grant.
--
-- The clean re-seed in 20260617004000 coalesces an unmatched signup subteam to
-- the 'UNK' pm.subteams row -- but no 'UNK' subteam was ever seeded, so the
-- coalesce yields NULL. A subteam-scoped membership (engineer/lead) with
-- subteam_id NULL reads in pm.has_capability as an ORG-WIDE grant (the
-- "m.subteam_id is null" branch applies everywhere), silently handing every
-- unmatched signup engineer/lead capabilities across the whole org.
--
-- This forward migration: (a) creates the missing 'UNK'/Unknown subteam,
-- (b) repairs existing data by re-pointing any subteam-scoped membership with a
-- NULL subteam_id to UNK (the safe, narrowest scope -- never a silent org-wide
-- grant), and (c) guards future inserts with a trigger so a subteam-scoped role
-- can never land with a NULL subteam_id again. Fully idempotent.

-- (a) Ensure the 'UNK' subteam exists. pm.subteams requires name/code/slug
--     (all NOT NULL + unique); insert only if the code is missing.
insert into pm.subteams (name, code, slug, sort_order)
select 'Unknown', 'UNK', 'unknown', 999
where not exists (select 1 from pm.subteams where code = 'UNK');

-- (b) Repair existing data: re-point any subteam-scoped membership (a role whose
--     definition is subteam-scoped) that landed with a NULL subteam_id to UNK.
--     Org-scoped roles (owner/executive) legitimately carry NULL and are left
--     alone. Guard against colliding with an existing identical (user, role, UNK)
--     membership (the unique index treats NULL subteam_id as the zero-uuid, so a
--     direct update could violate it): delete the duplicate-to-be first.
do $$
declare v_unk uuid;
begin
  select id into v_unk from pm.subteams where code = 'UNK';
  if v_unk is null then
    return; -- should not happen after (a); stay conservative.
  end if;

  -- Drop any NULL-subteam membership that would collide with an already-present
  -- (user, role, UNK) row, so the re-point below can't hit the unique index.
  delete from pm.role_memberships m
  where m.subteam_id is null
    and exists (
      select 1 from pm.roles r where r.id = m.role_id and r.scope = 'subteam'
    )
    and exists (
      select 1 from pm.role_memberships d
      where d.user_id = m.user_id and d.role_id = m.role_id and d.subteam_id = v_unk
    );

  update pm.role_memberships m
  set subteam_id = v_unk
  where m.subteam_id is null
    and exists (
      select 1 from pm.roles r where r.id = m.role_id and r.scope = 'subteam'
    );
end $$;

-- (c) Forward guard: a subteam-scoped role may never be inserted/updated with a
--     NULL subteam_id. A BEFORE trigger keeps this enforced regardless of which
--     write path (RPC, direct DML, future re-seed) inserts the row.
create or replace function pm.enforce_subteam_scope_membership()
returns trigger language plpgsql set search_path = pm, public as $$
declare v_scope text;
begin
  select scope into v_scope from pm.roles where id = new.role_id;
  if v_scope = 'subteam' and new.subteam_id is null then
    raise exception 'subteam-scoped role % requires a subteam_id (NULL would grant org-wide)', new.role_id
      using errcode = '23514';
  end if;
  if v_scope = 'org' and new.subteam_id is not null then
    raise exception 'org-scoped role % cannot be granted within a subteam', new.role_id
      using errcode = '23514';
  end if;
  return new;
end; $$;

drop trigger if exists trg_role_memberships_scope_guard on pm.role_memberships;
create trigger trg_role_memberships_scope_guard
  before insert or update on pm.role_memberships
  for each row execute function pm.enforce_subteam_scope_membership();
