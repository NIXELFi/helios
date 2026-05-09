create or replace function pdm.force_unlock(
  p_lock_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;
  if not pdm.is_admin() then
    raise exception 'admin role required to force-unlock';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required for force-unlock';
  end if;

  update pdm.locks
  set released_at = now(), force_released_by = v_caller
  where id = p_lock_id and released_at is null;

  if not found then
    raise exception 'lock % not active or not found', p_lock_id;
  end if;
end;
$$;

create or replace function public.pdm_force_unlock(p_lock_id uuid, p_reason text)
returns void
language sql security definer set search_path = pdm, public
as $$ select pdm.force_unlock(p_lock_id, p_reason); $$;

grant execute on function public.pdm_force_unlock(uuid, text) to authenticated;
