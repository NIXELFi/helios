-- Per-vault roles (20260531000000) created new 3-arg role functions but left
-- the OLD fixed-arg impls in place. Those impls' `on conflict (user_id)` is
-- broken now that user_roles' PK is composite — a 2-arg client call (the
-- existing useSetUserRole / useRevokeUserRole) would hit the broken path.
--
-- Drop the old fixed-arg impls + their proxies, then re-create 2-arg proxies
-- that delegate to the new vault-aware impls (p_vault_id defaults to NULL =
-- global). After this: 2-arg call = global grant/revoke (back-compat), 3-arg
-- call = per-vault.

-- Drop proxies first (they depend on the old impls), then the old impls.
drop function if exists public.pdm_set_user_role(uuid, text);
drop function if exists pdm.pdm_set_user_role(uuid, text);
drop function if exists pdm.set_user_role(uuid, text);
drop function if exists public.pdm_revoke_user_role(uuid);
drop function if exists pdm.pdm_revoke_user_role(uuid);
drop function if exists pdm.revoke_user_role(uuid);

-- 2-arg proxies → new vault-aware impl (NULL vault = global).
create or replace function pdm.pdm_set_user_role(p_target uuid, p_role text)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.set_user_role(p_target, p_role); $$;
create or replace function public.pdm_set_user_role(p_target uuid, p_role text)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.set_user_role(p_target, p_role); $$;
create or replace function pdm.pdm_revoke_user_role(p_target uuid)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.revoke_user_role(p_target); $$;
create or replace function public.pdm_revoke_user_role(p_target uuid)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.revoke_user_role(p_target); $$;

grant execute on function pdm.pdm_set_user_role(uuid, text), public.pdm_set_user_role(uuid, text) to authenticated;
grant execute on function pdm.pdm_revoke_user_role(uuid), public.pdm_revoke_user_role(uuid) to authenticated;
revoke execute on function public.pdm_set_user_role(uuid, text) from anon;
revoke execute on function public.pdm_revoke_user_role(uuid) from anon;

-- Redefine the 3-arg proxies WITHOUT a default for p_vault_id. With a default,
-- a 2-arg call matched both the 2-arg and 3-arg proxies → PostgREST PGRST203
-- "could not choose the best candidate". Requiring the 3rd arg makes 2-arg and
-- 3-arg calls each resolve to exactly one function. (The impl keeps its default;
-- it's called internally, not via PostgREST.) Postgres can't remove a default
-- via create-or-replace, so drop the defaulted 3-arg proxies first.
drop function if exists public.pdm_set_user_role(uuid, text, uuid);
drop function if exists pdm.pdm_set_user_role(uuid, text, uuid);
drop function if exists public.pdm_revoke_user_role(uuid, uuid);
drop function if exists pdm.pdm_revoke_user_role(uuid, uuid);
create or replace function pdm.pdm_set_user_role(p_target uuid, p_role text, p_vault_id uuid)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.set_user_role(p_target, p_role, p_vault_id); $$;
create or replace function public.pdm_set_user_role(p_target uuid, p_role text, p_vault_id uuid)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.set_user_role(p_target, p_role, p_vault_id); $$;
create or replace function pdm.pdm_revoke_user_role(p_target uuid, p_vault_id uuid)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.revoke_user_role(p_target, p_vault_id); $$;
create or replace function public.pdm_revoke_user_role(p_target uuid, p_vault_id uuid)
  returns void language sql security definer set search_path = pdm, public
  as $$ select pdm.revoke_user_role(p_target, p_vault_id); $$;
grant execute on function pdm.pdm_set_user_role(uuid, text, uuid), public.pdm_set_user_role(uuid, text, uuid) to authenticated;
grant execute on function pdm.pdm_revoke_user_role(uuid, uuid), public.pdm_revoke_user_role(uuid, uuid) to authenticated;
revoke execute on function public.pdm_set_user_role(uuid, text, uuid) from anon;
revoke execute on function public.pdm_revoke_user_role(uuid, uuid) from anon;
