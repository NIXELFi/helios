-- v4.4.6 fix: set_revision surfaces a raw unique_violation on a duplicate
-- explicit revision.
--
-- versions_file_revision_unique (20260530140000) enforces at most one version
-- per file carrying a given revision number. When a user stamps an EXPLICIT
-- revision already used on another version of the same file, set_revision
-- (current authoritative copy in 20260531000000) hits the unique index and the
-- raw "duplicate key value violates unique constraint" string reaches the
-- client. Pre-check and raise a friendly, actionable message instead.
-- CREATE OR REPLACE only; body otherwise unchanged. Idempotent.

create or replace function pdm.set_revision(p_file_id uuid, p_revision int default null)
returns pdm.versions language plpgsql security definer set search_path = pdm, public as $$
declare v_caller uuid := auth.uid(); v_vault uuid; v_latest uuid; v_next int; v_result pdm.versions;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select vault_id, latest_version_id into v_vault, v_latest from pdm.files where id = p_file_id;
  if not pdm.can_edit_in(v_vault) then raise exception 'editor role required to set revision'; end if;
  if v_latest is null then raise exception 'file % has no version to stamp a revision on', p_file_id; end if;
  if p_revision is not null then
    if p_revision <= 0 then raise exception 'revision must be a positive integer'; end if;
    -- Friendly pre-check: another version of THIS file already carries this
    -- revision (the unique index would otherwise raise a raw 23505).
    if exists (
      select 1 from pdm.versions
      where file_id = p_file_id and revision = p_revision and id <> v_latest
    ) then
      raise exception 'revision % is already used by another version of this file; pick a different number',
        p_revision using errcode = '22023';
    end if;
    v_next := p_revision;
  else
    select coalesce(max(revision), 0) + 1 into v_next from pdm.versions where file_id = p_file_id;
  end if;
  update pdm.versions set revision = v_next where id = v_latest returning * into v_result;
  insert into pdm.audit_log (user_id, action, target_type, target_id, payload)
    values (v_caller, 'set_revision', 'version', v_latest, jsonb_build_object('file_id', p_file_id, 'revision', v_next));
  return v_result;
end; $$;
