-- Fix CRITICAL C2 from ultrareview 2026-05-11:
-- 20260507000800_pdm_storage.sql created two RLS policies on
-- storage.objects that grant SELECT and INSERT to any authenticated
-- principal with no path or ownership check. Combined with the open
-- signup flow (enable_signup=true, no email confirmation pre-fix), any
-- attacker who could reach the auth endpoint could create an account
-- and immediately list/download every vault object plus upload arbitrary
-- bytes. The bucket's `public=false` flag was the only gate; once
-- authenticated, the gate was wide open.
--
-- This migration narrows access to "users who have an explicit role in
-- pdm.user_roles" — i.e. users an admin has invited. A fresh signup
-- without a role row cannot interact with the bucket at all:
--   * SELECT: requires a row in pdm.user_roles (any role).
--   * INSERT: requires role IN ('admin', 'editor').
--   * UPDATE/DELETE: still no policies → still denied.
--
-- Why role and not "active lock":
--   useAddLocalFile (apps/desktop/src/modules/vault/data/useAddLocalFile.ts)
--   uploads *before* acquiring a lock. A lock-required policy would block
--   step 4 of that flow. Requiring editor role is a meaningful narrowing
--   that the current client honors implicitly (only role-holders ever
--   reach the upload path) but the database was not enforcing.
--
-- Downloads via createSignedUrl bypass RLS (Supabase Storage short-circuits
-- signed URL access). The SELECT policy here governs direct authenticated
-- GETs (used by `objectExists` and bucket listing in
-- apps/desktop/src/modules/vault/data/useAddLocalFile.ts and useCheckIn.ts).

-- Drop the old wide-open policies.
drop policy if exists "vault-objects read for authenticated" on storage.objects;
drop policy if exists "vault-objects insert for authenticated" on storage.objects;

-- SELECT: must have a role.
create policy "vault-objects read for role-holders" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vault-objects'
    and exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid()
    )
  );

-- INSERT: must be editor or admin.
create policy "vault-objects insert for editors" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-objects'
    and exists (
      select 1 from pdm.user_roles
      where user_id = auth.uid() and role in ('admin', 'editor')
    )
  );

-- No UPDATE / DELETE policies. The bucket is content-addressed and
-- immutable from the client side; lifecycle management uses service role.
