-- Fix M18a: exclude soft-deleted files from all aggregations in
-- pdm.vault_insights_extra. Files with deleted_at IS NOT NULL are in the recycle
-- bin; counting them inflates activity_by_month, contributors, provenance, reuse
-- totals, and the datacard coverage numbers.
--
-- Fix M18b: the orphans predicate was logically inverted. The original query
-- required BOTH "no ref points at this file" AND "none of this file's versions
-- appear as a parent in any ref". That double-NOT-EXISTS excluded root assemblies
-- (assemblies that reference children but are not themselves referenced by
-- anything) — exactly the files that SHOULD be counted as orphans in a PDM
-- "where-used" sense. The correct definition of an orphan is a live file that is
-- not referenced as a child by any other version, regardless of whether it has
-- its own outgoing references. The second NOT EXISTS is dropped.
--
-- Return shape is identical to 20260603070000_pdm_vault_insights_extra_rpc.sql;
-- the frontend VaultInsightsExtra interface and DeepAnalytics component are
-- unchanged. CREATE OR REPLACE; idempotent. NOT YET APPLIED to any database —
-- needs apply + test on a staging/local Supabase (see audit branch).

create or replace function pdm.vault_insights_extra(p_vault_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pdm, public
as $fn$
  select jsonb_build_object(
    'activity_by_month', (
      select coalesce(jsonb_agg(jsonb_build_object('month', m, 'commits', c) order by m), '[]'::jsonb)
      from (
        select to_char(date_trunc('month', v.created_at), 'YYYY-MM') m, count(*) c
        from pdm.versions v join pdm.files f on f.id = v.file_id
        where f.vault_id = p_vault_id
          and f.deleted_at is null
        group by 1
      ) s
    ),
    'contributors', (
      select coalesce(jsonb_agg(jsonb_build_object('author_id', author_id, 'commits', c) order by c desc), '[]'::jsonb)
      from (
        select v.author_id, count(*) c
        from pdm.versions v join pdm.files f on f.id = v.file_id
        where f.vault_id = p_vault_id
          and f.deleted_at is null
        group by v.author_id
        order by c desc limit 12
      ) s
    ),
    'provenance', (
      select jsonb_build_object(
        'glassy', count(*) filter (where v.import_metadata->>'source' = 'glassypdm'),
        'native', count(*) filter (where v.import_metadata->>'source' is distinct from 'glassypdm')
      )
      from pdm.versions v join pdm.files f on f.id = v.file_id
      where f.vault_id = p_vault_id
        and f.deleted_at is null
    ),
    'checkouts', jsonb_build_object(
      'active', (
        select count(*) from pdm.locks l join pdm.files f on f.id = l.file_id
        where f.vault_id = p_vault_id and l.released_at is null
      ),
      'force_released_total', (
        select count(*) from pdm.locks l join pdm.files f on f.id = l.file_id
        where f.vault_id = p_vault_id and l.force_released_by is not null
      ),
      'longest_active', (
        select coalesce(jsonb_agg(jsonb_build_object('file_id', x.file_id, 'user_id', x.user_id, 'acquired_at', x.acquired_at) order by x.acquired_at asc), '[]'::jsonb)
        from (
          select l.file_id, l.user_id, l.acquired_at
          from pdm.locks l join pdm.files f on f.id = l.file_id
          where f.vault_id = p_vault_id and l.released_at is null
          order by l.acquired_at asc limit 5
        ) x
      )
    ),
    'reuse', jsonb_build_object(
      'most_referenced', (
        select coalesce(jsonb_agg(jsonb_build_object('file_id', child_file_id, 'refs', c) order by c desc), '[]'::jsonb)
        from (
          select r.child_file_id, count(*) c
          from pdm.refs r
          where r.child_file_id in (select id from pdm.files where vault_id = p_vault_id and deleted_at is null)
          group by r.child_file_id
          order by c desc limit 8
        ) s
      ),
      'orphans', (
        -- M18b fix: an orphan is a live file not referenced as a child by any
        -- other version. The original query also required the file to have no
        -- outgoing refs (second NOT EXISTS), which excluded root assemblies —
        -- exactly the unreferenced files that should be counted. Drop the second
        -- condition so any live file with no incoming ref is counted as an orphan.
        select count(*) from pdm.files f
        where f.vault_id = p_vault_id
          and f.deleted_at is null
          and not exists (select 1 from pdm.refs r where r.child_file_id = f.id)
      ),
      'total_links', (
        select count(*) from pdm.refs r
        where r.child_file_id in (select id from pdm.files where vault_id = p_vault_id and deleted_at is null)
      )
    ),
    'datacard', (
      select jsonb_build_object(
        'parts_total', count(*) filter (where lower(f.name) ~ '\.(sldprt|sldasm)$'),
        'with_card', count(*) filter (
          where lower(f.name) ~ '\.(sldprt|sldasm)$'
            and jsonb_array_length(case when jsonb_typeof(vv.properties) = 'array' then vv.properties else '[]'::jsonb end) > 0
        )
      )
      from pdm.files f
      left join pdm.versions vv on vv.id = f.latest_version_id
      where f.vault_id = p_vault_id
        and f.deleted_at is null
    )
  );
$fn$;

-- Re-state the grant idempotently (CREATE OR REPLACE drops execute permission
-- from roles that previously had it in some Postgres versions; re-granting is
-- safe and keeps the security posture consistent).
grant execute on function pdm.vault_insights_extra(uuid) to authenticated;
