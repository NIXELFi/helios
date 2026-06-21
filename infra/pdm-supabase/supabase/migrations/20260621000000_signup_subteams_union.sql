-- Signup subteam list: unify the two divergent subteam tables.
--
-- BUG (report 2026-06-21, Cole Diefenderfer): an admin added EV subteams
-- ("High Voltage", "Low Voltage", "Battery") in the admin area, but they did NOT
-- appear in the sign-up subteam dropdown.
--
-- ROOT CAUSE: there are TWO subteam tables serving different purposes:
--   * pdm.subteams  - identity/sign-up list; includes officer roles (President,
--     COO, CFO, Chief Engineer, ...). Anon-readable; the sign-up form reads this.
--   * pm.subteams   - PM module's engineering subsystems for task assignment
--     (Battery, High Voltage, Low Voltage, ...). authenticated-only.
-- The admin added the EV subteams via the PM subsystems admin (pm.subteams), but
-- sign-up only reads pdm.subteams, so they never showed up. Neither table is a
-- superset of the other.
--
-- FIX: a single SECURITY DEFINER RPC that returns the de-duplicated UNION of both
-- lists, callable by anon (sign-up happens before auth). This way a subteam added
-- in EITHER admin surface appears at sign-up, without exposing the pm schema to
-- anon and without polluting the PM task-assignment list with officer roles.
-- The 'Unknown' sentinel from pm.subteams is filtered out.

create or replace function public.list_signup_subteams()
returns table(name text)
language sql
stable
security definer
set search_path = pdm, pm, public
as $$
  select distinct s.name
  from (
    select name from pdm.subteams
    union all
    select name from pm.subteams
  ) s
  where lower(s.name) <> 'unknown'
  order by s.name;
$$;

-- Anon must call this from the sign-up form (pre-auth); authenticated too.
revoke all on function public.list_signup_subteams() from public;
grant execute on function public.list_signup_subteams() to anon, authenticated;
