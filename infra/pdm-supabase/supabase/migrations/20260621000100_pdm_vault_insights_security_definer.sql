-- vault_insights_extra: SECURITY INVOKER -> SECURITY DEFINER + membership guard.
--
-- Audit follow-up to 20260619000500 (flagged during the vault-audit review). As
-- SECURITY INVOKER the function read pdm.files/versions/locks/refs under the
-- CALLER's RLS, so the Insights dashboard under-counted: a member only saw
-- published files + their own drafts (files_read = is_member_in AND (published OR
-- own)), and every vault-wide aggregate (activity, contributors, provenance,
-- mass/BOM reuse, orphans, datacard) silently dropped everything else. An
-- analytics view should report vault-wide TRUTH to any member of that vault.
--
-- Recreate as SECURITY DEFINER (the owner, postgres, bypasses RLS) with an
-- explicit is_member_in(p_vault_id) guard so only members of the vault can call
-- it; non-members get NULL. Body is otherwise identical to 20260619000500.

create or replace function pdm.vault_insights_extra(p_vault_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pdm, public
as $fn$
  select case when not pdm.is_member_in(p_vault_id) then null else jsonb_build_object(
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
  ) end;
$fn$;

grant execute on function pdm.vault_insights_extra(uuid) to authenticated;
