-- Owners may approve their own marketplace submissions (Nick, 2026-09-30: "i need
-- to be able to approve my own since im the owner"). With review owner-only
-- (20260930000000) and self-approval blocked, nothing the owner published could
-- ever be approved.
--
-- Data-driven, not a hardcoded user: a new capability `marketplace.approve_own`,
-- granted to the owner role only. review_plugin_version skips the
-- separation-of-duties check for holders of it; everyone else still needs an
-- independent reviewer. To take it away:
--   delete from pm.role_capabilities where capability_key = 'marketplace.approve_own';

insert into pm.capabilities (key, label, description, scope) values
  ('marketplace.approve_own', 'Marketplace: approve own submissions',
   'Approve a plugin version you published yourself (skips the second-reviewer rule)', 'subteam')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

insert into pm.role_capabilities (role_id, capability_key)
select r.id, 'marketplace.approve_own' from pm.roles r where r.key = 'owner'
on conflict (role_id, capability_key) do nothing;

-- review_plugin_version: identical to 20260826010000 section 10 except the
-- self-approval check.
create or replace function marketplace.review_plugin_version(
  p_plugin_id text,
  p_version   text,
  p_decision  text,
  p_notes     text default null,
  p_report    jsonb default null
) returns table (
  plugin_id text, version text, review_status text,
  reviewed_by uuid, reviewed_at timestamptz
)
language plpgsql volatile security definer
set search_path = marketplace, pm, public as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_subteam   uuid;
  v_status    text;
  v_publisher uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected, got %', p_decision;
  end if;

  -- Lock the row so a concurrent withdraw cannot slip between this check and
  -- the update below.
  select pv.review_status, pv.published_by into v_status, v_publisher
  from marketplace.plugin_versions pv
  where pv.plugin_id = p_plugin_id and pv.version = p_version
  for update;
  if not found then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  v_subteam := marketplace.plugin_subteam(p_plugin_id);
  if not pm.has_capability(v_uid, 'marketplace.review', v_subteam) then
    raise exception 'insufficient privilege to review plugins for subteam %',
      coalesce(v_subteam::text, '<org>');
  end if;

  if v_status <> 'pending' then
    raise exception 'only a pending version can be reviewed (%@% is %)',
      p_plugin_id, p_version, v_status;
  end if;

  -- Separation of duties, with one data-driven exception: a holder of
  -- marketplace.approve_own for the owning subteam (the owner role) may approve
  -- their own submission. Everyone else still needs an independent reviewer.
  if p_decision = 'approved' and v_uid = v_publisher
     and not pm.has_capability(v_uid, 'marketplace.approve_own', v_subteam) then
    raise exception 'you cannot approve your own submission; it needs an independent reviewer';
  end if;

  update marketplace.plugin_versions pv
    set review_status = p_decision,
        reviewed_by   = v_uid,
        reviewed_at   = now(),
        review_notes  = p_notes,
        review_report = coalesce(p_report, pv.review_report)
    where pv.plugin_id = p_plugin_id and pv.version = p_version;

  update marketplace.plugins p
    set latest_version = (
          select pv.version from marketplace.plugin_versions pv
          where pv.plugin_id = p_plugin_id and pv.review_status = 'approved'
          order by pv.published_at desc limit 1
        ),
        -- The display name follows the newest APPROVED version (a pending
        -- submission no longer renames the live plugin; see publish).
        name = coalesce((
          select pv.manifest->>'name' from marketplace.plugin_versions pv
          where pv.plugin_id = p_plugin_id and pv.review_status = 'approved'
          order by pv.published_at desc limit 1
        ), p.name),
        updated_at = now()
    where p.id = p_plugin_id;

  return query
    select pv.plugin_id, pv.version, pv.review_status, pv.reviewed_by, pv.reviewed_at
    from marketplace.plugin_versions pv
    where pv.plugin_id = p_plugin_id and pv.version = p_version;
end $$;
revoke execute on function marketplace.review_plugin_version(text, text, text, text, jsonb) from public, anon;
grant execute on function marketplace.review_plugin_version(text, text, text, text, jsonb) to authenticated, service_role;
