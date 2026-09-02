-- The owner pickers (task create dialog, task detail sheet, board/table filter
-- bar) list the WHOLE directory in one flat, alphabetical run. Reported by a
-- Data Acquisition member on 2026-08-26: "I want the options for owners to be
-- limited to those in my subteam, its annoying to search through the whole team
-- directory".
--
-- The client holds no membership data at all today, so it cannot order or group
-- that list. This adds the one missing fact -- which subteams a person belongs
-- to -- to the directory RPC the PM workspace already loads on every hydrate.
--
-- ADDITIVE: id/name/email keep their names, order and semantics, so a client
-- that ignores the new column behaves exactly as before. Postgres will not let
-- CREATE OR REPLACE change a function's OUT columns, hence the drop + create.
--
-- Membership is INCOMPLETE in practice (41 of 107 users carried a legacy
-- subteam_memberships row at the time of writing; Org & Access grants are
-- unioned in below), which is precisely why the client RANKS on this column
-- rather than filtering by it -- filtering would hide two thirds of the team, and assigning
-- across subteams has to stay possible either way.
--
-- GRANTS: deliberately restored to exactly what the function had before this
-- migration (execute to PUBLIC, which covers anon + authenticated). Dropping a
-- function resets its ACL, so this block is what keeps behaviour identical.
-- NOTE: that pre-existing PUBLIC/anon grant means an anon-key holder can read
-- every member's name and email through this SECURITY DEFINER function. That is
-- the state today, not something introduced here; tightening it to
-- authenticated-only is a separate change that needs every client checked first
-- (the Helios Lite web port is not in this repo).
--
-- Apply to hosted via the Management API query endpoint (the hosted migration
-- history is drifted -- never `supabase db push`).

drop function if exists pm.list_directory();

create function pm.list_directory()
returns table (id uuid, name text, email text, subteam_ids uuid[])
language sql
stable
security definer
set search_path to 'pm', 'public', 'auth'
as $$
  select
    u.id,
    coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), u.email::text),
    u.email::text,
    coalesce(
      (
        -- Org & Access is the LIVE source: grant_role writes pm.role_memberships
        -- (subteam_id null = org-scoped, skipped). pm.subteam_memberships is the
        -- one-shot 2026-06-17 backfill nothing writes to any more -- kept as a
        -- second source so the June seed still counts, exactly the way
        -- notify.lead_email (20260714020000) resolves leads. Reading only the
        -- legacy table would freeze the ranking at June and miss everyone
        -- granted since.
        select array_agg(distinct c.subteam_id order by c.subteam_id)
        from (
          select rm.subteam_id
            from pm.role_memberships rm
           where rm.user_id = u.id and rm.subteam_id is not null
          union
          select sm.subteam_id
            from pm.subteam_memberships sm
           where sm.user_id = u.id
        ) c
      ),
      '{}'::uuid[]
    )
  from auth.users u
  order by 2 asc;
$$;

grant execute on function pm.list_directory() to public;
grant execute on function pm.list_directory() to anon;
grant execute on function pm.list_directory() to authenticated;
