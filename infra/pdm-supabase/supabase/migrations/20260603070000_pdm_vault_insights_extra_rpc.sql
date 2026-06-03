-- Server-side aggregation powering the Vault Insights "deep analytics" cards
-- (real commit history, true contributors, provenance, checkout analytics, CAD
-- reuse, data-card coverage). Returns one small jsonb so the client never ships
-- thousands of version/ref rows. SECURITY INVOKER: aggregates only what the
-- caller can already read under RLS. Applied to dlmyixonuyckxkknolku via MCP;
-- this file keeps the repo in sync.
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
        group by 1
      ) s
    ),
    'contributors', (
      select coalesce(jsonb_agg(jsonb_build_object('author_id', author_id, 'commits', c) order by c desc), '[]'::jsonb)
      from (
        select v.author_id, count(*) c
        from pdm.versions v join pdm.files f on f.id = v.file_id
        where f.vault_id = p_vault_id
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
          where r.child_file_id in (select id from pdm.files where vault_id = p_vault_id)
          group by r.child_file_id
          order by c desc limit 8
        ) s
      ),
      'orphans', (
        select count(*) from pdm.files f
        where f.vault_id = p_vault_id
          and not exists (select 1 from pdm.refs r where r.child_file_id = f.id)
          and not exists (
            select 1 from pdm.refs r2 join pdm.versions v on v.id = r2.parent_version_id
            where v.file_id = f.id
          )
      ),
      'total_links', (
        select count(*) from pdm.refs r
        where r.child_file_id in (select id from pdm.files where vault_id = p_vault_id)
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
    )
  );
$fn$;

grant execute on function pdm.vault_insights_extra(uuid) to authenticated;
