-- v5.0.0 Marketplace — Sub-project B, Phase 3b: publish / list / install RPCs.
--
-- All writes to the marketplace tables go through these SECURITY DEFINER RPCs
-- (the tables have no direct write policy). Publishing re-validates the manifest
-- SERVER-SIDE (never trust the client), enforces `marketplace.publish` for the
-- owning subteam, and signs the version at publish time. Installing refuses any
-- non-approved version. Bundle bytes are fetched by the client from the `plugins`
-- Storage bucket via a short-lived signed URL it mints AFTER install_plugin
-- validates (Supabase signed URLs are a Storage-API op, not a SQL one) — the
-- desktop then verifies sha256 + signature before unpacking.

-- ---------------------------------------------------------------------------
-- 0. Server-side manifest validation (mirrors @helios/plugin-sdk validateManifest
--    core rules). Raises on any violation; returns the normalized id/version.
-- ---------------------------------------------------------------------------
create or replace function marketplace.validate_manifest(p_manifest jsonb)
returns void language plpgsql immutable as $$
declare
  v_id      text := p_manifest->>'id';
  v_name    text := p_manifest->>'name';
  v_version text := p_manifest->>'version';
  v_entry   text := p_manifest->>'entry';
  v_sdk     text := p_manifest->>'sdk';
  v_perm    jsonb := coalesce(p_manifest->'permissions', '[]'::jsonb);
begin
  if jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception 'manifest must be a JSON object';
  end if;
  if (p_manifest->>'format') is distinct from '1' then
    raise exception 'manifest.format must be 1';
  end if;
  -- id doubles as a filesystem directory name on install, so it is restricted to
  -- a safe single-segment charset (lowercase alnum + . - _, no traversal).
  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9._-]*$' or length(v_id) > 200 then
    raise exception 'manifest.id is missing or invalid: %', coalesce(v_id, '<null>');
  end if;
  if v_name is null or length(trim(v_name)) = 0 then
    raise exception 'manifest.name is required';
  end if;
  if v_version is null or v_version !~ '^[0-9]+\.[0-9]+\.[0-9]+([.-].+)?$' then
    raise exception 'manifest.version must be semver: %', coalesce(v_version, '<null>');
  end if;
  if v_entry is null or length(v_entry) = 0
     or left(v_entry, 1) = '/' or position('..' in v_entry) > 0 then
    raise exception 'manifest.entry must be a relative path without "..": %', coalesce(v_entry, '<null>');
  end if;
  if v_sdk is null or length(v_sdk) = 0 then
    raise exception 'manifest.sdk (SDK version range) is required';
  end if;
  if jsonb_typeof(v_perm) is distinct from 'array' then
    raise exception 'manifest.permissions must be an array';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. publish_plugin_version — submit a new version (lands 'pending').
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
-- See install_plugin: the RETURNS TABLE OUT columns shadow same-named table columns.
-- Resolve bare identifiers to columns (every variable is read via a qualified name).
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

  -- Ownership: for an EXISTING plugin, ownership cannot be reassigned — the
  -- caller must hold publish on the plugin's CURRENT subteam. For a new plugin,
  -- the caller claims `p_subteam` and must hold publish there.
  select subteam into v_subteam from marketplace.plugins where id = v_id;
  if found then
    if not pm.has_capability(v_uid, 'marketplace.publish', v_subteam) then
      raise exception 'insufficient privilege to publish to plugin % (subteam %)', v_id, v_subteam;
    end if;
    update marketplace.plugins
      set name = v_name, updated_at = now()
      where id = v_id;
  else
    v_subteam := p_subteam;
    if not pm.has_capability(v_uid, 'marketplace.publish', v_subteam) then
      raise exception 'insufficient privilege to publish a new plugin to subteam %', coalesce(v_subteam::text, '<org>');
    end if;
    insert into marketplace.plugins (id, name, subteam, created_by)
      values (v_id, v_name, v_subteam, v_uid);
  end if;

  -- Versions are immutable.
  if exists (select 1 from marketplace.plugin_versions pv
             where pv.plugin_id = v_id and pv.version = v_version) then
    raise exception 'version % of % already exists (versions are immutable)', v_version, v_id;
  end if;

  -- Sign the canonical message at publish time.
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
grant execute on function marketplace.publish_plugin_version(jsonb, text, bigint, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. list_available_plugins — discoverable plugins (newest approved version per
--    plugin) + the caller's installed version. SECURITY INVOKER so RLS applies.
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
    on inst.plugin_id = p.id and inst.user_id = auth.uid();
$$;
grant execute on function marketplace.list_available_plugins() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. install_plugin — record the caller's install of an APPROVED version and
--    return the metadata the desktop needs to download + verify the bundle.
-- ---------------------------------------------------------------------------
create or replace function marketplace.install_plugin(p_plugin_id text, p_version text)
returns table (
  plugin_id text, version text, manifest jsonb,
  bundle_sha256 text, bundle_bytes bigint,
  signature text, sig_alg text, signing_key_id text
)
language plpgsql volatile security definer
set search_path = marketplace, public as $$
-- The RETURNS TABLE OUT columns (plugin_id, version, …) are in-scope variables that
-- collide with the same-named table columns below (notably plugin_id in the INSERT's
-- ON CONFLICT target) → "column reference is ambiguous". Resolve bare names to
-- columns; every variable we actually read is accessed via a qualified name.
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

  insert into marketplace.plugin_installs (user_id, plugin_id, installed_version)
    values (v_uid, p_plugin_id, p_version)
  on conflict (user_id, plugin_id)
    do update set installed_version = excluded.installed_version, installed_at = now();

  return query
    select v_row.plugin_id, v_row.version, v_row.manifest,
           v_row.bundle_sha256, v_row.bundle_bytes,
           v_row.signature, v_row.sig_alg, v_row.signing_key_id;
end $$;
grant execute on function marketplace.install_plugin(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. uninstall_plugin — drop the caller's install row.
-- ---------------------------------------------------------------------------
create or replace function marketplace.uninstall_plugin(p_plugin_id text)
returns void
language plpgsql volatile security definer
set search_path = marketplace, public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  delete from marketplace.plugin_installs
    where user_id = v_uid and plugin_id = p_plugin_id;
end $$;
grant execute on function marketplace.uninstall_plugin(text) to authenticated;
