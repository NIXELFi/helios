create or replace function pdm.cancel_checkout(p_file_id uuid)
returns void
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

  update pdm.locks
  set released_at = now()
  where file_id = p_file_id
    and user_id = v_caller
    and released_at is null;

  if not found then
    raise exception 'no active lock held by caller for file %', p_file_id;
  end if;
end;
$$;

create or replace function public.pdm_cancel_checkout(p_file_id uuid)
returns void
language sql security definer set search_path = pdm, public
as $$ select pdm.cancel_checkout(p_file_id); $$;

grant execute on function public.pdm_cancel_checkout(uuid) to authenticated;
