-- WhoHasWhat needs lock -> file -> vault resolution across every vault the
-- caller belongs to, but files_read draft privacy (20260610100000) hides
-- other users' unpublished drafts from direct reads — so the client-side
-- join dumped every draft checkout into an unresolvable "Other vaults"
-- bucket. This definer RPC returns the join server-side. It reveals no more
-- than the policies intend: rows are membership-gated exactly like
-- locks_read, and a draft's NAME is redacted (null) unless the caller is the
-- draft's creator or an admin in that vault — the lock's existence, holder,
-- and timing are already visible to members via locks_read.
create or replace function pdm.pdm_list_active_checkouts()
returns table (
  lock_id uuid,
  file_id uuid,
  file_name text,
  vault_id uuid,
  vault_name text,
  folder_id uuid,
  user_id uuid,
  acquired_at timestamptz,
  is_draft boolean,
  deleted_at timestamptz
)
language sql stable security definer set search_path = pdm, public as $$
  select
    l.id,
    f.id,
    case
      when f.published_at is null
       and f.created_by is distinct from auth.uid()
       and not pdm.is_admin_in(f.vault_id)
      then null
      else f.name
    end,
    f.vault_id,
    v.name,
    f.folder_id,
    l.user_id,
    l.acquired_at,
    (f.published_at is null),
    f.deleted_at
  from pdm.locks l
  join pdm.files f on f.id = l.file_id
  join pdm.vaults v on v.id = f.vault_id
  where l.released_at is null
    and pdm.is_member_in(f.vault_id);
$$;

revoke all on function pdm.pdm_list_active_checkouts() from public, anon;
grant execute on function pdm.pdm_list_active_checkouts() to authenticated;
