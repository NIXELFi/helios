-- Refs soft-delete fix: reresolve_refs_for_file re-resolves refs owned by a
-- soft-deleted PARENT assembly.
--
-- pdm.reresolve_refs_for_file() (trigger, current source 20260618000400) walks
-- pdm.refs r joined to its parent version pv → parent file pf, and re-resolves a
-- child hint when this (NEW) file is the unique live basename match. The join to
-- the parent file pf does NOT exclude soft-deleted parents, so a ref OWNED BY A
-- SOFT-DELETED PARENT ASSEMBLY (pf.deleted_at is not null — i.e. an assembly in
-- the recycle bin) still gets its child re-resolved. That silently revives refs
-- on tombstoned assemblies (and pins them to a now-live child), polluting the
-- Where-Used graph with edges from deleted parents.
--
-- The team already added this exact guard (`and pf.deleted_at is null`) to the
-- sibling restore path handle_file_deleted_at_change() in 20260619000300 (the
-- "M-3" comment), but never back-ported it to reresolve_refs_for_file().
--
-- Fix: add `and pf.deleted_at is null` to the forward-resolution UPDATE. CREATE
-- OR REPLACE only; the rest of the trigger body (including the existing
-- new.deleted_at early-return and the latest_version_id pin) is verbatim from
-- 20260618000400. Idempotent.

create or replace function pdm.reresolve_refs_for_file()
returns trigger language plpgsql security definer set search_path = pdm, public as $$
declare
  v_count int;
begin
  -- A soft-deleted file shouldn't (re)resolve refs to itself; if NEW is deleted,
  -- there is nothing to point at.
  if new.deleted_at is not null then
    return new;
  end if;

  -- Same rule as record_refs: only a UNIQUE case-insensitive basename match
  -- among LIVE files in the vault resolves.
  select count(*) into v_count
  from pdm.files
  where vault_id = new.vault_id and lower(name) = lower(new.name) and deleted_at is null;

  if v_count = 1 then
    update pdm.refs r
    set child_file_id = new.id,
        child_version_id = coalesce(new.latest_version_id, r.child_version_id)
    from pdm.versions pv
    join pdm.files pf on pf.id = pv.file_id
    where pv.id = r.parent_version_id
      and pf.vault_id = new.vault_id
      and pf.deleted_at is null   -- don't re-resolve refs owned by a soft-deleted PARENT assembly
      and r.child_file_id is null
      and lower(regexp_replace(r.child_path_hint, '^.*[/\\]', '')) = lower(new.name);
  end if;

  if new.latest_version_id is not null then
    update pdm.refs
    set child_version_id = new.latest_version_id
    where child_file_id = new.id and child_version_id is null;
  end if;

  return new;
end; $$;
