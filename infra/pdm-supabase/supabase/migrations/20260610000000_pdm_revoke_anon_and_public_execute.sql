-- Lock down RPC execute grants (security-advisor sweep 2026-06-09).
-- APPLIED TO HOSTED 2026-06-09 via MCP apply_migration (verified: anon=0/75,
-- authenticated=68, service_role=69 — exactly the non-trigger set).
--
-- Postgres grants EXECUTE to PUBLIC on every new function by default, so each
-- migration since the 2026-05-11 anon revoke quietly re-exposed its functions
-- to `anon` via /rest/v1/rpc. Every function has an in-body auth.uid()/role
-- guard (audited), so nothing was exploitable — but unauthenticated callers
-- have no business reaching SECURITY DEFINER functions at all.
--
-- Rule: all pdm.* and public.pdm_* functions lose anon + PUBLIC execute.
-- Non-trigger functions get explicit authenticated + service_role grants,
-- preserving every current legitimate caller (import_version's service-role
-- access previously rode the implicit PUBLIC grant — its in-body JWT check
-- remains the real gate). test_reset keeps its postgres/service_role-only
-- grants. Trigger functions need no caller grants at all.
-- Default privileges stop future functions from regrowing PUBLIC execute.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname as name, n.nspname as schema_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'pdm')
       or (n.nspname = 'public' and p.proname like 'pdm\_%')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
    if r.name = 'test_reset' or r.name like 'trg\_%' then
      continue; -- stays postgres/service_role-only (test_reset) / owner-run (triggers)
    end if;
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;

-- Future functions in pdm: no implicit PUBLIC execute (set for the roles that
-- create functions via migrations / dashboard).
alter default privileges in schema pdm revoke execute on functions from public;
alter default privileges for role postgres in schema pdm revoke execute on functions from public;

-- Unrelated advisor fix: pin the one mutable search_path (pm trigger helper).
alter function pm.set_updated_at() set search_path = pm, public;
