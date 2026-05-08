-- Versions
alter table pdm.versions enable row level security;

create policy versions_read on pdm.versions
  for select to authenticated using (true);

-- Insert: caller must hold the active lock on the file AND be the author.
create policy versions_insert_lockholder on pdm.versions
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from pdm.locks
      where locks.file_id = versions.file_id
        and locks.user_id = auth.uid()
        and locks.released_at is null
    )
  );

-- Update / delete: nobody (admin can use service role for emergencies, but
-- versions are immutable in normal operation).
-- (No update/delete policies = no rows pass the using clause = denied.)

-- Refs
alter table pdm.refs enable row level security;

create policy refs_read on pdm.refs
  for select to authenticated using (true);

-- Insert / update / delete: nobody from the client. The parse-refs edge function
-- uses the service role to populate this table.
