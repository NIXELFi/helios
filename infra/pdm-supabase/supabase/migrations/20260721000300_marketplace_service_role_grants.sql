-- Give service_role the same blanket grants on the marketplace schema that
-- every other schema has (pdm 20260507000000:99-103, pm 20260602000000:
-- 1056-1074). The marketplace schema (20260626000000) never granted it, so
-- the backend admin key 42501s on any marketplace DML through PostgREST —
-- inconsistent with its role everywhere else, and it blocks the (still
-- missing) marketplace RLS/RPC test suites, whose harness seeds data via the
-- service client. service_role already carries BYPASSRLS; this only aligns
-- table grants with the rest of the database.

grant usage on schema marketplace to service_role;
grant all on all tables in schema marketplace to service_role;
grant all on all sequences in schema marketplace to service_role;
alter default privileges in schema marketplace grant all on tables to service_role;
alter default privileges in schema marketplace grant all on sequences to service_role;
