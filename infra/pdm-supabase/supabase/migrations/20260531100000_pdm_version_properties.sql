-- Data cards: store a version's SolidWorks custom properties.
--
-- Properties are auxiliary metadata derived from the file (parsed client-side
-- by parse_sw_properties), stored as a JSON array [{name, value}] on the
-- version. The version's content (sha256/version_num) stays immutable; this is
-- just a derived-metadata column, written via a SECURITY DEFINER RPC (clients
-- have no direct UPDATE on pdm.versions).

alter table pdm.versions add column if not exists properties jsonb;

-- Set (replace) a version's parsed properties. Editor+ of the version's vault.
-- Used at check-in (the author has editor rights) and by the backfill pass.
create or replace function pdm.set_version_properties(p_version_id uuid, p_properties jsonb)
returns void language plpgsql security definer set search_path = pdm, public as $$
declare
  v_caller uuid := auth.uid();
  v_vault uuid;
begin
  if v_caller is null then raise exception 'authentication required'; end if;
  select f.vault_id into v_vault
  from pdm.versions v join pdm.files f on f.id = v.file_id
  where v.id = p_version_id;
  if v_vault is null then raise exception 'version % not found', p_version_id; end if;
  if not pdm.can_edit_in(v_vault) then
    raise exception 'editor role required to set properties';
  end if;
  update pdm.versions set properties = p_properties where id = p_version_id;
end; $$;

create or replace function pdm.pdm_set_version_properties(p_version_id uuid, p_properties jsonb)
returns void language sql security definer set search_path = pdm, public
as $$ select pdm.set_version_properties(p_version_id, p_properties); $$;
create or replace function public.pdm_set_version_properties(p_version_id uuid, p_properties jsonb)
returns void language sql security definer set search_path = pdm, public
as $$ select pdm.set_version_properties(p_version_id, p_properties); $$;

revoke all on function pdm.set_version_properties(uuid, jsonb) from public, anon;
revoke all on function public.pdm_set_version_properties(uuid, jsonb) from public, anon;
grant execute on function pdm.set_version_properties(uuid, jsonb) to authenticated;
grant execute on function pdm.pdm_set_version_properties(uuid, jsonb) to authenticated;
grant execute on function public.pdm_set_version_properties(uuid, jsonb) to authenticated;
revoke execute on function public.pdm_set_version_properties(uuid, jsonb) from anon;
