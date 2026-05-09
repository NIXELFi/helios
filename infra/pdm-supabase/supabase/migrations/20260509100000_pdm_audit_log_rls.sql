-- pdm.audit_log was the one table in the pdm schema with no RLS enabled.
-- The Supabase database advisor (correctly) flags this as a risk because
-- the schema is exposed via PostgREST and `authenticated` already had a
-- blanket SELECT grant from the original schema migration's
-- `grant select on all tables in schema pdm to authenticated`.
--
-- Behavior is unchanged: any authenticated user can still read every row
-- (this is a single-team app, audit visibility is desired). RLS is now
-- enabled with a permissive SELECT policy + no client-side write policies,
-- which means INSERT/UPDATE/DELETE are gated to security-definer functions
-- only — exactly what already drives audit writes today (trg_locks_audit,
-- check_in / force_unlock / cancel_checkout).

alter table pdm.audit_log enable row level security;

-- Read: any authenticated user. Same single-team convention as locks/files/etc.
create policy audit_log_read on pdm.audit_log
  for select to authenticated using (true);

-- No INSERT / UPDATE / DELETE policies for `authenticated`. Writes are done
-- exclusively by SECURITY DEFINER functions (trg_locks_audit and the three
-- mutation RPCs), which run as the function owner and are not subject to RLS
-- on `authenticated`. The service role bypasses RLS entirely for emergencies.
