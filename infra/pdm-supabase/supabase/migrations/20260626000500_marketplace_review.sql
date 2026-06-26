-- v5.0.0 Marketplace — Sub-project D, Phase 1: review transition + reviewer queue.
--
-- A submitted version sits at review_status='pending' and is invisible to members
-- (B's RLS only exposes 'approved'). A reviewer with `marketplace.review` for the
-- owning subteam (lead/vp) — or an org reviewer (exec/owner) — approves or rejects
-- it here. Approval is the ONLY path to 'approved', the only state B distributes,
-- so this RPC is the gate that lets untrusted code reach other members. Every
-- approval is therefore a human decision (there is no auto-approve), which also
-- satisfies the Tier-2 "human approval required" rule; D.3's UI additionally hides
-- any auto-approve affordance for Tier-2 plugins.

-- review_report holds the automated scan findings (D.3 runChecks) + any dynamic
-- transcript (Phase 2). B added reviewed_by/reviewed_at/review_notes already.
alter table marketplace.plugin_versions
  add column if not exists review_report jsonb;

-- ---------------------------------------------------------------------------
-- review_plugin_version — approve or reject a version. Gated on marketplace.review
-- for the plugin's OWNING subteam (org reviewers pass for any subteam via their
-- org-scoped membership). On approval, recompute plugins.latest_version to the
-- newest approved version (publish-time order, matching list_available_plugins).
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
declare
  v_uid     uuid := auth.uid();
  v_subteam uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected, got %', p_decision;
  end if;

  if not exists (
    select 1 from marketplace.plugin_versions pv
    where pv.plugin_id = p_plugin_id and pv.version = p_version
  ) then
    raise exception 'no such version: %@%', p_plugin_id, p_version;
  end if;

  v_subteam := marketplace.plugin_subteam(p_plugin_id);
  if not pm.has_capability(v_uid, 'marketplace.review', v_subteam) then
    raise exception 'insufficient privilege to review plugins for subteam %',
      coalesce(v_subteam::text, '<org>');
  end if;

  update marketplace.plugin_versions pv
    set review_status = p_decision,
        reviewed_by   = v_uid,
        reviewed_at   = now(),
        review_notes  = p_notes,
        review_report = coalesce(p_report, pv.review_report)
    where pv.plugin_id = p_plugin_id and pv.version = p_version;

  -- Keep the denormalized latest_version pointing at the newest approved version
  -- (or NULL if this rejection removed the last approval).
  update marketplace.plugins p
    set latest_version = (
          select pv.version from marketplace.plugin_versions pv
          where pv.plugin_id = p_plugin_id and pv.review_status = 'approved'
          order by pv.published_at desc limit 1
        ),
        updated_at = now()
    where p.id = p_plugin_id;

  return query
    select pv.plugin_id, pv.version, pv.review_status, pv.reviewed_by, pv.reviewed_at
    from marketplace.plugin_versions pv
    where pv.plugin_id = p_plugin_id and pv.version = p_version;
end $$;
grant execute on function marketplace.review_plugin_version(text, text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- review_queue — pending versions the caller may review. SECURITY INVOKER so the
-- plugin_versions RLS (which already exposes pending rows only to the owning
-- subteam's publishers + reviewers) does the visibility filtering; we further
-- restrict to rows the caller can actually review.
-- ---------------------------------------------------------------------------
create or replace function marketplace.review_queue()
returns table (
  plugin_id text, name text, subteam uuid, version text,
  manifest jsonb, permissions text[], review_report jsonb,
  bundle_sha256 text, bundle_bytes bigint,
  published_by uuid, published_at timestamptz
)
language sql stable
set search_path = marketplace, pm, public as $$
  select
    pv.plugin_id, p.name, p.subteam, pv.version,
    pv.manifest, pv.permissions, pv.review_report,
    pv.bundle_sha256, pv.bundle_bytes,
    pv.published_by, pv.published_at
  from marketplace.plugin_versions pv
  join marketplace.plugins p on p.id = pv.plugin_id
  where pv.review_status = 'pending'
    and pm.has_capability(auth.uid(), 'marketplace.review', p.subteam)
  order by pv.published_at asc;
$$;
grant execute on function marketplace.review_queue() to authenticated;
