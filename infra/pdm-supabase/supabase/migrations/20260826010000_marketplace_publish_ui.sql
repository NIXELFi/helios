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
-- 0. Preflight. publish_plugin_version (10b) now reads storage.objects from a
--    SECURITY DEFINER function, which only sees rows if the owning role bypasses
--    RLS (Supabase's `postgres` does; the SQL editor relies on it). Fail the
--    apply loudly rather than ship a publish RPC that can never find a bundle.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)
  ) then
    raise exception 'apply this migration as a role that bypasses RLS (e.g. postgres); % does not', current_user;
  end if;
end $$;

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
-- 4b. can_manage_version — who may withdraw or yank a version: the person who
--     published it, or a reviewer for the owning subteam. Being a publisher on
--     the same subteam is NOT enough; an engineer must not be able to pull a
--     teammate's release.
-- ---------------------------------------------------------------------------
create or replace function marketplace.can_manage_version(
  p_uid uuid, p_plugin_id text, p_version text
) returns boolean
language sql stable security definer
set search_path = marketplace, pm, public as $$
  select p_uid is not null and (
    exists (
      select 1 from marketplace.plugin_versions pv
      where pv.plugin_id = p_plugin_id and pv.version = p_version
        and pv.published_by = p_uid
        and pm.has_capability(p_uid, 'marketplace.publish', marketplace.plugin_subteam(p_plugin_id))
    )
    or pm.has_capability(p_uid, 'marketplace.review', marketplace.plugin_subteam(p_plugin_id))
  );
$$;

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

  -- FOR UPDATE: review_plugin_version locks the same row, so a concurrent
  -- approve and withdraw serialise instead of the later write silently
  -- overwriting the earlier one.
  select pv.review_status into v_status
  from marketplace.plugin_versions pv
  where pv.plugin_id = p_plugin_id and pv.version = p_version
  for update;
  if not found then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  if not marketplace.can_manage_version(v_uid, p_plugin_id, p_version) then
    raise exception 'only the author of %@% or a reviewer for its subteam can withdraw it',
      p_plugin_id, p_version;
  end if;

  if v_status <> 'pending' then
    raise exception 'only a pending submission can be withdrawn (%@% is %)',
      p_plugin_id, p_version, v_status;
  end if;

  update marketplace.plugin_versions pv
    set review_status = 'withdrawn'
    where pv.plugin_id = p_plugin_id and pv.version = p_version
      and pv.review_status = 'pending';

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
  where pv.plugin_id = p_plugin_id and pv.version = p_version
  for update;
  if not found then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  if not marketplace.can_manage_version(v_uid, p_plugin_id, p_version) then
    raise exception 'only the author of %@% or a reviewer for its subteam can yank it',
      p_plugin_id, p_version;
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
    where pv.plugin_id = p_plugin_id and pv.version = p_version
      and pv.review_status = 'approved';

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
  -- Recommending puts a plugin in front of the whole subteam, so it is a lead's
  -- call (marketplace.review), not any publisher's.
  if not pm.has_capability(v_uid, 'marketplace.review', marketplace.plugin_subteam(p_plugin_id)) then
    raise exception 'only a lead or VP for this subteam can change whether % is recommended', p_plugin_id;
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
  p_plugin_id        text,
  p_version          text,
  p_replace_install  boolean default false
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

  -- The install cache holds ONE copy per plugin, so a preview physically replaces
  -- the reviewer's real install of it. Never do that silently: the client must
  -- ask first and come back with p_replace_install = true. The error text is
  -- matched by the client (publishErrors / useReview), keep it stable.
  if not coalesce(p_replace_install, false) and exists (
    select 1 from marketplace.plugin_installs i
    where i.user_id = v_uid and i.plugin_id = p_plugin_id and i.is_preview = false
  ) then
    raise exception 'PREVIEW_REPLACES_INSTALL: test-driving %@% replaces your installed copy of %',
      p_plugin_id, p_version, p_plugin_id;
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
grant execute on function marketplace.install_plugin_for_review(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. install_plugin — redefined so a normal install always CLEARS is_preview.
--    Without this, a reviewer who test-drove a build and later installs the
--    approved version keeps a row flagged as a preview: Browse (which ignores
--    previews) says "Install" forever and Uninstall is unreachable. Body is the
--    20260626000300 original plus the one assignment.
-- ---------------------------------------------------------------------------
create or replace function marketplace.install_plugin(p_plugin_id text, p_version text)
returns table (
  plugin_id text, version text, manifest jsonb,
  bundle_sha256 text, bundle_bytes bigint,
  signature text, sig_alg text, signing_key_id text
)
language plpgsql volatile security definer
set search_path = marketplace, public as $$
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
  if v_row.review_status <> 'approved' then
    raise exception 'version %@% is not installable (status: %)', p_plugin_id, p_version, v_row.review_status;
  end if;

  insert into marketplace.plugin_installs (user_id, plugin_id, installed_version, is_preview)
    values (v_uid, p_plugin_id, p_version, false)
  on conflict (user_id, plugin_id)
    do update set installed_version = excluded.installed_version,
                  installed_at      = now(),
                  is_preview        = false;

  return query
    select v_row.plugin_id, v_row.version, v_row.manifest,
           v_row.bundle_sha256, v_row.bundle_bytes,
           v_row.signature, v_row.sig_alg, v_row.signing_key_id;
end $$;
grant execute on function marketplace.install_plugin(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. review_plugin_version — redefined to act ONLY on a pending version.
--     The original checked existence, not state, so a reviewer with a stale queue
--     could approve a build its author had just withdrawn (shipping it to
--     members), and a direct call could flip a yanked release back to approved.
--     Otherwise identical to 20260626000500.
-- ---------------------------------------------------------------------------
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

  if p_decision = 'approved' and v_uid = v_publisher then
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
grant execute on function marketplace.review_plugin_version(text, text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 10b. publish_plugin_version — redefined to refuse a version whose bundle is not
--      actually in the `plugins` bucket (or is a different size). A version row
--      is what installs and the reviewer's scan download, so pointing one at a
--      missing or squatted object would only fail later, for everyone. Body is
--      the 20260626000300 original plus the storage check.
-- ---------------------------------------------------------------------------
create or replace function marketplace.publish_plugin_version(
  p_manifest jsonb,
  p_sha256   text,
  p_bytes    bigint,
  p_subteam  uuid default null
) returns table (
  plugin_id text, version text, review_status text,
  bundle_sha256 text, signature text, signing_key_id text, published_at timestamptz
)
language plpgsql volatile security definer
set search_path = marketplace, pm, public as $$
#variable_conflict use_column
declare
  v_uid     uuid := auth.uid();
  v_id      text := p_manifest->>'id';
  v_version text := p_manifest->>'version';
  v_name    text := p_manifest->>'name';
  v_perms   text[];
  v_subteam uuid;
  v_sig     record;
  v_msg     bytea;
  v_stored  bigint;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  perform marketplace.validate_manifest(p_manifest);

  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'bundle_sha256 must be a 64-char hex digest';
  end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > 26214400 then
    raise exception 'bundle_bytes out of range (1..25MiB): %', coalesce(p_bytes::text, '<null>');
  end if;

  v_perms := array(select jsonb_array_elements_text(coalesce(p_manifest->'permissions', '[]'::jsonb)));

  select subteam into v_subteam from marketplace.plugins where id = v_id;
  if found then
    if not pm.has_capability(v_uid, 'marketplace.publish', v_subteam) then
      raise exception 'insufficient privilege to publish to plugin % (subteam %)', v_id, v_subteam;
    end if;
    -- No rename here: the name every member sees changes only when a version
    -- carrying it is APPROVED (review_plugin_version), never on submission.
  else
    v_subteam := p_subteam;
    if not pm.has_capability(v_uid, 'marketplace.publish', v_subteam) then
      raise exception 'insufficient privilege to publish a new plugin to subteam %', coalesce(v_subteam::text, '<org>');
    end if;
    insert into marketplace.plugins (id, name, subteam, created_by)
      values (v_id, v_name, v_subteam, v_uid);
  end if;

  -- After the capability checks, so a non-publisher cannot use this to probe
  -- which bundles exist in the private bucket.
  -- The bytes must already be uploaded. Storage records the object size in
  -- metadata; when it is there it must match what the version will claim.
  select coalesce((o.metadata->>'size')::bigint, -1) into v_stored
  from storage.objects o
  where o.bucket_id = 'plugins' and o.name = lower(p_sha256)
  limit 1;
  if not found then
    raise exception 'bundle % is not in storage; upload it before publishing', lower(p_sha256);
  end if;
  if v_stored <> -1 and v_stored <> p_bytes then
    raise exception 'bundle % in storage is % bytes, not %', lower(p_sha256), v_stored, p_bytes;
  end if;

  if exists (select 1 from marketplace.plugin_versions pv
             where pv.plugin_id = v_id and pv.version = v_version) then
    raise exception 'version % of % already exists (versions are immutable)', v_version, v_id;
  end if;

  v_msg := marketplace.signing_message(v_id, v_version, p_sha256, p_bytes);
  select * into v_sig from marketplace.sign_message(v_msg);

  insert into marketplace.plugin_versions (
    plugin_id, version, manifest, permissions, bundle_sha256, bundle_bytes,
    review_status, signature, sig_alg, signing_key_id, published_by
  ) values (
    v_id, v_version, p_manifest, v_perms, lower(p_sha256), p_bytes,
    'pending', v_sig.signature, v_sig.sig_alg, v_sig.signing_key_id, v_uid
  );

  return query
    select pv.plugin_id, pv.version, pv.review_status,
           pv.bundle_sha256, pv.signature, pv.signing_key_id, pv.published_at
    from marketplace.plugin_versions pv
    where pv.plugin_id = v_id and pv.version = v_version;
end $$;

-- ---------------------------------------------------------------------------
-- 11. my_installed_plugins — the caller's installs, built from THEIR install
--     rows rather than from the list of currently-offered plugins. Yanking a
--     plugin's only approved version takes it out of list_available_plugins, but
--     it is still unpacked on the member's disk and must stay openable and
--     uninstallable. Previews are included (flagged) so a reviewer can open a
--     test-drive build and remove it afterwards. SECURITY DEFINER because a
--     yanked/pending version row is hidden from members by RLS; it only ever
--     returns the caller's own rows.
-- ---------------------------------------------------------------------------
create or replace function marketplace.my_installed_plugins()
returns table (
  plugin_id text, name text, subteam uuid, is_recommended boolean,
  installed_version text, is_preview boolean, installed_at timestamptz,
  review_status text, manifest jsonb, permissions text[],
  latest_version text
)
language sql stable security definer
set search_path = marketplace, public as $$
  select
    i.plugin_id, p.name, p.subteam, p.is_recommended,
    i.installed_version, i.is_preview, i.installed_at,
    pv.review_status, pv.manifest, pv.permissions,
    p.latest_version
  from marketplace.plugin_installs i
  join marketplace.plugins p on p.id = i.plugin_id
  left join marketplace.plugin_versions pv
    on pv.plugin_id = i.plugin_id and pv.version = i.installed_version
  where auth.uid() is not null and i.user_id = auth.uid()
  order by p.name asc
$$;
grant execute on function marketplace.my_installed_plugins() to authenticated;

-- ---------------------------------------------------------------------------
-- 12. signing_public_key_for — the public key a SPECIFIC version was signed
--     with. Installs used to verify against whichever key is active now, so the
--     first key rotation would have broken every older version. Retired keys
--     keep their public half (active = false), so this still resolves them.
-- ---------------------------------------------------------------------------
create or replace function marketplace.signing_public_key_for(p_key_id text)
returns table (key_id text, public_key text, alg text)
language sql stable security definer
set search_path = marketplace, public as $$
  select id, encode(public_key, 'base64'), alg
  from marketplace.signing_keys where id = p_key_id;
$$;
grant execute on function marketplace.signing_public_key_for(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. validate_manifest — tightened to match @helios/plugin-sdk validateManifest:
--     permissions must come from the catalog (packages/plugin-sdk/src/
--     capabilities.ts) and entry may not smuggle traversal as %2e/%2f/%5c, a
--     backslash, or a URL scheme. A direct RPC caller could previously store
--     junk that only the desktop loader rejected, at launch.
-- ---------------------------------------------------------------------------
create or replace function marketplace.validate_manifest(p_manifest jsonb)
returns void language plpgsql immutable
set search_path = marketplace, public as $$
declare
  v_id      text := p_manifest->>'id';
  v_name    text := p_manifest->>'name';
  v_version text := p_manifest->>'version';
  v_entry   text := p_manifest->>'entry';
  v_sdk     text := p_manifest->>'sdk';
  v_perm    jsonb := coalesce(p_manifest->'permissions', '[]'::jsonb);
  v_bad     jsonb;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception 'manifest must be a JSON object';
  end if;
  -- Mirrors packages/plugin-sdk/src/manifest.ts (SUPPORTED_FORMAT, ID_RE,
  -- SEMVER_RE) so nothing the desktop loader would refuse can be published. The
  -- id and version each become a directory name in the install cache, so a
  -- trailing dot (Windows drops it, colliding with another plugin's folder) or a
  -- '/' in a pre-release tag must never get this far.
  if jsonb_typeof(p_manifest->'format') is distinct from 'number'
     or (p_manifest->>'format')::numeric <> 1 then
    raise exception 'manifest.format must be the number 1';
  end if;
  if v_id is null or v_id !~ '^[a-z0-9]+([-.][a-z0-9]+)*$' or length(v_id) > 200 then
    raise exception 'manifest.id is missing or invalid: %', coalesce(v_id, '<null>');
  end if;
  if v_name is null or length(trim(v_name)) = 0 then
    raise exception 'manifest.name is required';
  end if;
  if v_version is null or v_version !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
     or right(v_version, 1) = '.' then
    raise exception 'manifest.version must be semver: %', coalesce(v_version, '<null>');
  end if;
  if not (p_manifest ? 'permissions') then
    raise exception 'manifest.permissions is required (use [] for none)';
  end if;
  if v_entry is null or length(trim(v_entry)) = 0
     or left(v_entry, 1) = '/'
     or position('..' in v_entry) > 0
     or position(chr(92) in v_entry) > 0
     or v_entry ~* '%(2e|2f|5c)'
     or v_entry ~ '^[a-zA-Z][a-zA-Z0-9+.-]*:' then
    raise exception 'manifest.entry must be a plain relative path inside the bundle: %', coalesce(v_entry, '<null>');
  end if;
  if v_sdk is null or length(v_sdk) = 0 then
    raise exception 'manifest.sdk (SDK version range) is required';
  end if;
  if jsonb_typeof(v_perm) is distinct from 'array' then
    raise exception 'manifest.permissions must be an array';
  end if;
  select e into v_bad
  from jsonb_array_elements(v_perm) as t(e)
  where jsonb_typeof(e) <> 'string'
     or (e #>> '{}') not in ('file.read', 'file.write', 'storage', 'engine:matlab')
  limit 1;
  if v_bad is not null then
    raise exception 'manifest.permissions contains an unknown permission: %', v_bad::text;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 14. Storage hardening for the `plugins` bucket.
--     * Size and type limits at the bucket, so the 25 MiB ceiling is enforced by
--       Storage itself and not only by the publish RPC after the bytes landed.
--     * Uploaders can read back THEIR OWN objects. The submit flow treats "an
--       object with this sha256 already exists" as success; with this it can
--       download that object and prove it really is the same bytes instead of
--       trusting the name (an object squatted under a predicted name, or a
--       half-finished earlier upload, is caught before a version points at it).
-- ---------------------------------------------------------------------------
update storage.buckets
  set file_size_limit = 26214400,
      allowed_mime_types = array['application/zip', 'application/octet-stream']
  where id = 'plugins';

-- The upload gate ("can this person publish anywhere?") used to query
-- pm.role_memberships / pm.role_capabilities directly as the uploader, so it only
-- worked while those tables' own RLS happened to expose the right rows (own
-- memberships; role_capabilities only to org members). A SECURITY DEFINER helper
-- asks the question directly and does not depend on that chain.
create or replace function marketplace.can_publish_anywhere(p_uid uuid)
returns boolean
language sql stable security definer
set search_path = marketplace, pm, public as $$
  select p_uid is not null and exists (
    select 1
    from pm.role_memberships m
    join pm.role_capabilities rc on rc.role_id = m.role_id
    where m.user_id = p_uid and rc.capability_key = 'marketplace.publish'
  );
$$;

drop policy if exists "marketplace_plugins_insert" on storage.objects;
create policy "marketplace_plugins_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'plugins'
    and name ~ '^[0-9a-f]{64}$'
    and marketplace.can_publish_anywhere(auth.uid())
  );

drop policy if exists "marketplace_plugins_read_own_upload" on storage.objects;
create policy "marketplace_plugins_read_own_upload" on storage.objects
  for select to authenticated
  using (bucket_id = 'plugins' and (owner = auth.uid() or owner_id = auth.uid()::text));

-- ---------------------------------------------------------------------------
-- 15. Function privileges, schema-wide.
--     Postgres grants EXECUTE on every new function to PUBLIC by default, and
--     `revoke ... from authenticated, anon` does not touch that grant. So
--     marketplace.sign_message — the function that signs with the marketplace's
--     private key — has been callable by every signed-in user over PostgREST
--     since 20260626000200. Strip PUBLIC/anon from everything in the schema, then
--     grant back exactly the API surface. Internal helpers (sign_message,
--     signing_message, validate_manifest, can_manage_version) are reachable only
--     from the SECURITY DEFINER functions that call them as the owner.
--     plugin_subteam stays granted: RLS policies call it as the querying user.
--     service_role (the backend admin key) gets the same API surface it had
--     through PUBLIC, so admin scripts keep working.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema marketplace from public, anon;
revoke execute on function marketplace.sign_message(bytea) from authenticated;
revoke execute on function marketplace.signing_message(text, text, text, bigint) from authenticated;
revoke execute on function marketplace.validate_manifest(jsonb) from authenticated;
revoke execute on function marketplace.can_manage_version(uuid, text, text) from authenticated;
-- NOTE: `alter default privileges in schema marketplace revoke ... from public`
-- would be a no-op (per-schema defaults can only ADD privileges), and the global
-- form would change every future function in every schema. So each future
-- migration that creates a marketplace function must revoke PUBLIC itself;
-- tests/marketplace-function-grants.structure.test.ts enforces that.

grant execute on function
  marketplace.plugin_subteam(text),
  marketplace.signing_public_key(),
  marketplace.signing_public_key_for(text),
  marketplace.publish_plugin_version(jsonb, text, bigint, uuid),
  marketplace.list_available_plugins(),
  marketplace.install_plugin(text, text),
  marketplace.uninstall_plugin(text),
  marketplace.review_plugin_version(text, text, text, text, jsonb),
  marketplace.review_queue(),
  marketplace.my_published_plugins(),
  marketplace.my_installed_plugins(),
  marketplace.withdraw_plugin_version(text, text),
  marketplace.yank_plugin_version(text, text, text),
  marketplace.set_plugin_recommended(text, boolean),
  marketplace.install_plugin_for_review(text, text, boolean),
  -- Called from a storage.objects policy, which runs as the uploader.
  marketplace.can_publish_anywhere(uuid)
to authenticated, service_role;
