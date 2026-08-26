-- Add to Marketplace (2026-08-26) — the author-facing half of the marketplace.
-- Plan: docs/superpowers/plans/2026-08-26-marketplace-add-to-marketplace.md
-- Spec: docs/superpowers/specs/2026-08-26-marketplace-add-to-marketplace-design.md
--
-- The publish/review/install backend has been live since 2026-07-01, but nothing
-- in the app could reach it: publishing was a hand-run Management API sequence.
-- This migration adds what a self-serve publishing UI needs and nothing more:
--
--   1. two new terminal states — 'withdrawn' (author pulled a pending submission)
--      and 'yanked' (author pulled a bad release);
--   2. `is_preview` on installs, so a reviewer can test-drive a PENDING build
--      without Browse reporting an unapproved version as their installed one;
--   3. the author-side RPCs (list mine / withdraw / yank / recommend);
--   4. `install_plugin_for_review`, a SEPARATE path for reviewer previews so the
--      approved-only rule inside `install_plugin` stays absolute.
--
-- Distribution is unchanged: `list_available_plugins` and `install_plugin` both
-- test `review_status = 'approved'`, and `review_queue` tests `= 'pending'`, so
-- the two new states fall out of distribution AND out of the review queue without
-- either being touched. Every mutating function re-checks capabilities
-- server-side — the UI gating is a convenience, never the boundary.

-- ---------------------------------------------------------------------------
-- 1. Widen the review_status check.
--    The original constraint is a column-level check created inline by
--    20260626000000_marketplace_schema.sql, so Postgres named it
--    `plugin_versions_review_status_check`. Rather than trust that, drop whatever
--    check constraint on the table actually mentions review_status — a hardcoded
--    name that does not match would silently leave the old three-state constraint
--    in place and every withdraw/yank below would fail at runtime.
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'marketplace'
      and rel.relname = 'plugin_versions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%review_status%'
  loop
    execute format('alter table marketplace.plugin_versions drop constraint %I', v_name);
  end loop;
end $$;

alter table marketplace.plugin_versions
  add constraint plugin_versions_review_status_check
  check (review_status in ('pending','approved','rejected','withdrawn','yanked'));

-- ---------------------------------------------------------------------------
-- 2. Reviewer preview installs.
--    A preview is a real install (it downloads, verifies, and unpacks exactly
--    like any other) so that a reviewer runs the same bytes members would. It is
--    flagged so Browse can ignore it.
-- ---------------------------------------------------------------------------
alter table marketplace.plugin_installs
  add column if not exists is_preview boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. list_available_plugins — unchanged except that preview installs no longer
--    count as "installed". Body copied from 20260626000300_marketplace_rpcs.sql
--    with the single added predicate, so the two stay diffable.
-- ---------------------------------------------------------------------------
create or replace function marketplace.list_available_plugins()
returns table (
  id text, name text, subteam uuid, is_recommended boolean,
  version text, manifest jsonb, permissions text[],
  installed_version text, published_at timestamptz
)
language sql stable
set search_path = marketplace, public as $$
  select
    p.id, p.name, p.subteam, p.is_recommended,
    latest.version, latest.manifest, latest.permissions,
    inst.installed_version, latest.published_at
  from marketplace.plugins p
  join lateral (
    select pv.version, pv.manifest, pv.permissions, pv.published_at
    from marketplace.plugin_versions pv
    where pv.plugin_id = p.id and pv.review_status = 'approved'
    order by pv.published_at desc
    limit 1
  ) latest on true
  left join marketplace.plugin_installs inst
    on inst.plugin_id = p.id
   and inst.user_id = auth.uid()
   and inst.is_preview = false
$$;
grant execute on function marketplace.list_available_plugins() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. my_published_plugins — one row per VERSION of every plugin the caller may
--    publish to, including non-approved ones. SECURITY INVOKER: the existing
--    plugin_versions RLS already exposes pending/rejected rows to the owning
--    subteam's publishers, so RLS does the visibility work and this only shapes
--    the result.
-- ---------------------------------------------------------------------------
create or replace function marketplace.my_published_plugins()
returns table (
  plugin_id text, name text, subteam uuid, is_recommended boolean,
  latest_version text, version text, manifest jsonb, permissions text[],
  review_status text, review_notes text, reviewed_at timestamptz,
  bundle_bytes bigint, published_by uuid, published_at timestamptz
)
language sql stable
set search_path = marketplace, pm, public as $$
  select
    p.id, p.name, p.subteam, p.is_recommended,
    p.latest_version, pv.version, pv.manifest, pv.permissions,
    pv.review_status, pv.review_notes, pv.reviewed_at,
    pv.bundle_bytes, pv.published_by, pv.published_at
  from marketplace.plugins p
  join marketplace.plugin_versions pv on pv.plugin_id = p.id
  where pm.has_capability(auth.uid(), 'marketplace.publish', p.subteam)
  order by p.name asc, pv.published_at desc
$$;
grant execute on function marketplace.my_published_plugins() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. withdraw_plugin_version — an author pulls their own PENDING submission.
--    No latest_version recompute: a pending row was never the latest.
-- ---------------------------------------------------------------------------
create or replace function marketplace.withdraw_plugin_version(
  p_plugin_id text,
  p_version   text
) returns table (plugin_id text, version text, review_status text)
language plpgsql volatile security definer
set search_path = marketplace, pm, public as $$
-- The RETURNS TABLE OUT columns shadow same-named table columns (see install_plugin).
#variable_conflict use_column
declare
  v_uid    uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select pv.review_status into v_status
  from marketplace.plugin_versions pv
  where pv.plugin_id = p_plugin_id and pv.version = p_version;
  if not found then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  if not pm.has_capability(v_uid, 'marketplace.publish', marketplace.plugin_subteam(p_plugin_id)) then
    raise exception 'insufficient privilege to manage plugin %', p_plugin_id;
  end if;

  if v_status <> 'pending' then
    raise exception 'only a pending submission can be withdrawn (%@% is %)',
      p_plugin_id, p_version, v_status;
  end if;

  update marketplace.plugin_versions pv
    set review_status = 'withdrawn'
    where pv.plugin_id = p_plugin_id and pv.version = p_version;

  return query
    select pv.plugin_id, pv.version, pv.review_status
    from marketplace.plugin_versions pv
    where pv.plugin_id = p_plugin_id and pv.version = p_version;
end $$;
grant execute on function marketplace.withdraw_plugin_version(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. yank_plugin_version — an author pulls a bad APPROVED release.
--    Existing installs keep working: they are already unpacked on disk and served
--    from the local cache. Yanking only stops the version being offered and
--    installed. latest_version is recomputed with the EXACT query
--    review_plugin_version uses, so the two can never disagree.
-- ---------------------------------------------------------------------------
create or replace function marketplace.yank_plugin_version(
  p_plugin_id text,
  p_version   text,
  p_reason    text default null
) returns table (plugin_id text, version text, review_status text, latest_version text)
language plpgsql volatile security definer
set search_path = marketplace, pm, public as $$
#variable_conflict use_column
declare
  v_uid    uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select pv.review_status into v_status
  from marketplace.plugin_versions pv
  where pv.plugin_id = p_plugin_id and pv.version = p_version;
  if not found then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  if not pm.has_capability(v_uid, 'marketplace.publish', marketplace.plugin_subteam(p_plugin_id)) then
    raise exception 'insufficient privilege to manage plugin %', p_plugin_id;
  end if;

  if v_status <> 'approved' then
    raise exception 'only an approved version can be yanked (%@% is %)',
      p_plugin_id, p_version, v_status;
  end if;

  update marketplace.plugin_versions pv
    set review_status = 'yanked',
        review_notes  = case
          when p_reason is null or length(trim(p_reason)) = 0 then pv.review_notes
          else concat_ws(E'\n', pv.review_notes, 'Yanked by the author: ' || p_reason)
        end
    where pv.plugin_id = p_plugin_id and pv.version = p_version;

  update marketplace.plugins p
    set latest_version = (
          select pv.version from marketplace.plugin_versions pv
          where pv.plugin_id = p_plugin_id and pv.review_status = 'approved'
          order by pv.published_at desc limit 1
        ),
        updated_at = now()
    where p.id = p_plugin_id;

  return query
    select pv.plugin_id, pv.version, pv.review_status, p.latest_version
    from marketplace.plugin_versions pv
    join marketplace.plugins p on p.id = pv.plugin_id
    where pv.plugin_id = p_plugin_id and pv.version = p_version;
end $$;
grant execute on function marketplace.yank_plugin_version(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. set_plugin_recommended — the owning subteam's "we recommend this" flag.
-- ---------------------------------------------------------------------------
create or replace function marketplace.set_plugin_recommended(
  p_plugin_id text,
  p_value     boolean
) returns table (plugin_id text, is_recommended boolean)
language plpgsql volatile security definer
set search_path = marketplace, pm, public as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (select 1 from marketplace.plugins p where p.id = p_plugin_id) then
    raise exception 'no such plugin: %', p_plugin_id;
  end if;
  if not pm.has_capability(v_uid, 'marketplace.publish', marketplace.plugin_subteam(p_plugin_id)) then
    raise exception 'insufficient privilege to manage plugin %', p_plugin_id;
  end if;

  update marketplace.plugins p
    set is_recommended = coalesce(p_value, false), updated_at = now()
    where p.id = p_plugin_id;

  return query
    select p.id, p.is_recommended from marketplace.plugins p where p.id = p_plugin_id;
end $$;
grant execute on function marketplace.set_plugin_recommended(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. install_plugin_for_review — a reviewer test-drives a PENDING build.
--    Deliberately a separate function rather than a flag on install_plugin: the
--    "approved only" rule there is the line that keeps unreviewed code away from
--    members, and it should stay unconditional and easy to read. This path
--    requires marketplace.review on the owning subteam, accepts ONLY 'pending',
--    and marks the install row is_preview so Browse ignores it.
-- ---------------------------------------------------------------------------
create or replace function marketplace.install_plugin_for_review(
  p_plugin_id text,
  p_version   text
) returns table (
  plugin_id text, version text, manifest jsonb,
  bundle_sha256 text, bundle_bytes bigint,
  signature text, sig_alg text, signing_key_id text
)
language plpgsql volatile security definer
set search_path = marketplace, pm, public as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_row marketplace.plugin_versions%rowtype;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select * into v_row from marketplace.plugin_versions pv
    where pv.plugin_id = p_plugin_id and pv.version = p_version;
  if not found then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  if not pm.has_capability(v_uid, 'marketplace.review', marketplace.plugin_subteam(p_plugin_id)) then
    raise exception 'insufficient privilege to preview plugins for subteam %',
      coalesce(marketplace.plugin_subteam(p_plugin_id)::text, '<org>');
  end if;

  -- Previews exist to review UNREVIEWED code. An approved version is installed
  -- through the normal path, so refusing it here keeps the two paths honest.
  if v_row.review_status <> 'pending' then
    raise exception 'only a pending version can be previewed (%@% is %)',
      p_plugin_id, p_version, v_row.review_status;
  end if;

  insert into marketplace.plugin_installs (user_id, plugin_id, installed_version, is_preview)
    values (v_uid, p_plugin_id, p_version, true)
  on conflict (user_id, plugin_id)
    do update set installed_version = excluded.installed_version,
                  installed_at      = now(),
                  is_preview        = true;

  return query
    select v_row.plugin_id, v_row.version, v_row.manifest,
           v_row.bundle_sha256, v_row.bundle_bytes,
           v_row.signature, v_row.sig_alg, v_row.signing_key_id;
end $$;
grant execute on function marketplace.install_plugin_for_review(text, text) to authenticated;
