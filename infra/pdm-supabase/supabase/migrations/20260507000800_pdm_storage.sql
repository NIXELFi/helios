-- Create the private bucket. INSERT into storage.buckets is the canonical
-- migration-time path (Supabase Storage uses regular Postgres tables under the hood).
insert into storage.buckets (id, name, public)
values ('vault-objects', 'vault-objects', false)
on conflict (id) do nothing;

-- RLS for storage.objects (already enabled by Supabase Storage; we just add policies).

-- Authenticated users can read via signed URLs (Supabase Storage handles the
-- signed-URL bypass automatically; this policy lets them list/get raw objects
-- when the JS client falls back to authenticated GETs).
create policy "vault-objects read for authenticated" on storage.objects
  for select to authenticated
  using (bucket_id = 'vault-objects');

-- Authenticated users can upload (the JS client's createSignedUploadUrl path).
create policy "vault-objects insert for authenticated" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vault-objects');

-- No update / delete from clients. The bucket is content-addressed and
-- immutable; lifecycle / cleanup happens via service-role admin tools later.
