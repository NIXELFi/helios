-- v4.4.6: give pdm.list_vault_roles parity with pdm.admin_list_users by also
-- returning display_name + subteam.
--
-- Context: the vault lock-holder name resolution (BrowseScreen / WhoHasWhatScreen)
-- was switched to the vault-scoped useVaultUsers(vaultId) RPC so that PER-VAULT
-- admins (not only global admins) can see who holds a checkout. But the
-- vault-scoped RPC previously returned only `email`, while the holder label is
-- `display_name ?? email` -- so the switch would have degraded the label from the
-- human name to the bare email for everyone. Returning display_name/subteam here
-- restores name-first labels on the vault-scoped path, with no regression for the
-- common global-admin case.
--
-- Changing the RETURNS TABLE signature requires dropping the functions first
-- (CREATE OR REPLACE cannot alter a function's return columns). Wrappers depend on
-- the base function, so drop them first, then the base, then recreate in order.

drop function if exists public.pdm_list_vault_roles(uuid);
drop function if exists pdm.pdm_list_vault_roles(uuid);
drop function if exists pdm.list_vault_roles(uuid);

-- Base: each user + their EFFECTIVE role in the vault (per-vault row if present,
-- else the global row; `scope` distinguishes), now including the display name and
-- subteam sourced from auth.users.raw_user_meta_data (same source as
-- pdm.admin_list_users, added in 20260529010000).
create function pdm.list_vault_roles(p_vault_id uuid)
returns table (
  user_id uuid, email text, display_name text, subteam text,
  role text, scope text, granted_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = pdm, public, auth as $$
begin
  if not (pdm.is_admin() or pdm.is_admin_in(p_vault_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select u.id,
           u.email::text,
           (u.raw_user_meta_data->>'display_name')::text,
           (u.raw_user_meta_data->>'subteam')::text,
           coalesce(rv.role, rg.role) as role,
           case when rv.role is not null then 'vault'
                when rg.role is not null then 'global'
                else null end as scope,
           coalesce(rv.granted_at, rg.granted_at) as granted_at,
           u.created_at
    from auth.users u
    left join pdm.user_roles rv on rv.user_id = u.id and rv.vault_id = p_vault_id
    left join pdm.user_roles rg on rg.user_id = u.id and rg.vault_id is null
    order by u.created_at asc;
end; $$;

create function pdm.pdm_list_vault_roles(p_vault_id uuid)
returns table (
  user_id uuid, email text, display_name text, subteam text,
  role text, scope text, granted_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = pdm, public
as $$ select * from pdm.list_vault_roles(p_vault_id); $$;

create function public.pdm_list_vault_roles(p_vault_id uuid)
returns table (
  user_id uuid, email text, display_name text, subteam text,
  role text, scope text, granted_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = pdm, public
as $$ select * from pdm.list_vault_roles(p_vault_id); $$;

grant execute on function pdm.pdm_list_vault_roles(uuid), public.pdm_list_vault_roles(uuid) to authenticated;
revoke execute on function public.pdm_list_vault_roles(uuid) from anon;
