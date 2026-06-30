-- Feature: editable, persisted display ICON (glyph) per PM subteam.
-- Today the subteam icon is DERIVED at runtime from name/code (apps/desktop
-- .../pm/components/SubteamIcon.tsx, glyphForSubteam). This adds an optional
-- stored override so a lead/exec/owner can pick a subteam's icon and have the
-- choice persist for everyone.
--
-- icon = NULL means "no override" -> the client falls back to the auto-derived
-- glyph, so every existing subteam is unchanged until someone picks one.
--
-- Permission: a NEW capability `pm.set_subteam_icon` granted to owner, executive
-- AND lead. The write RPC authorizes on holding that capability in ANY scope
-- (org OR any subteam) -- so a lead of any subteam may set any subteam's icon,
-- matching the request ("doesn't matter which subteam they're on"). The icon is
-- the ONLY field this loosened path can change; name/code/color/structure stay
-- gated by their existing (stricter) policies/RPCs.
--
-- Conventions mirror 20260617000000 (capability/role seed) + 20260617006000 /
-- 20260624000000 (SECURITY DEFINER write RPC re-checking the capability). Every
-- statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. The stored override column. Free-form text; the client validates against
--    its glyph bank on render and the RPC below rejects junk. NULL = auto-derive.
-- ---------------------------------------------------------------------------
alter table pm.subteams add column if not exists icon text;

-- ---------------------------------------------------------------------------
-- 2. Capability: pm.set_subteam_icon. A NEW capability (NOT org.manage_structure,
--    which is owner/exec only) so leads can curate icons without the broader
--    structure-editing powers, and so the role editor can hand it out separately.
-- ---------------------------------------------------------------------------
insert into pm.capabilities (key, label, description, scope) values
  ('pm.set_subteam_icon', 'Set subteam icon',
   'Choose the display icon for any subteam (persists for everyone)', 'subteam')
on conflict (key) do update
  set label = excluded.label, description = excluded.description, scope = excluded.scope;

-- ---------------------------------------------------------------------------
-- 3. Seed onto owner + executive + lead. Unlike the org-scoped gates elsewhere,
--    the RPC below accepts the capability held in ANY scope, so a SUBTEAM-scoped
--    'lead' grant is honored (a lead of one subteam may set any subteam's icon).
--    Idempotent.
-- ---------------------------------------------------------------------------
insert into pm.role_capabilities (role_id, capability_key)
select r.id, 'pm.set_subteam_icon'
from pm.roles r
where r.key in ('owner', 'executive', 'lead')
on conflict (role_id, capability_key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Write RPC (SECURITY DEFINER). Authorization is enforced HERE: the caller
--    must hold pm.set_subteam_icon in ANY scope (org-scoped OR any subteam
--    membership). This is DELIBERATELY NOT pm.has_capability(..., NULL), which
--    honors only org-scoped grants and would exclude subteam-scoped leads -- so
--    we check the membership join directly, ignoring subteam scope. Bypasses the
--    table's admin-only write RLS for THIS column only. p_icon NULL clears it.
-- ---------------------------------------------------------------------------
create or replace function pm.set_subteam_icon(p_id uuid, p_icon text)
returns void language plpgsql security definer set search_path = pm, public as $$
declare v_caller uuid := auth.uid(); v_icon text;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from pm.role_memberships m
    join pm.role_capabilities rc on rc.role_id = m.role_id
    where m.user_id = v_caller and rc.capability_key = 'pm.set_subteam_icon'
  ) then
    raise exception 'not authorized to set subteam icons' using errcode = '42501';
  end if;
  v_icon := nullif(btrim(coalesce(p_icon, '')), '');
  -- An icon key is a short lowercase slug. NULL stays NULL (auto-derive); anything
  -- that isn't a plausible key is rejected rather than stored as garbage.
  if v_icon is not null and v_icon !~ '^[a-z][a-z0-9_-]{0,31}$' then
    raise exception 'invalid icon key %', p_icon using errcode = '22023';
  end if;
  update pm.subteams set icon = v_icon, updated_at = now() where id = p_id;
end; $$;

grant execute on function pm.set_subteam_icon(uuid, text) to authenticated;
