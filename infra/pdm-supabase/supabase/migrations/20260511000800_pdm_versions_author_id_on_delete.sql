-- Fix the deferred LOW finding from ultrareview 2026-05-11:
-- pdm.versions.author_id is `NOT NULL` and references auth.users(id) with
-- the default ON DELETE RESTRICT. The Supabase admin API cannot delete a
-- user who has any version history without first manually re-pointing or
-- deleting every version they authored — which makes user-departure
-- workflows in prod impossible.
--
-- This migration:
--   1. Drops the NOT NULL constraint on author_id (so SET NULL is a valid
--      target).
--   2. Drops and recreates the FK with ON DELETE SET NULL.
--
-- Code-side impact: pdm-core Version.author_id changes from UserId to
-- Option<UserId>; types.ts Version.author_id from UserId to UserId|null.
-- Historical version rows whose author was deleted will surface as
-- "unknown author" in any future UI. The audit trail
-- (id/sha256/size_bytes/created_at/parent_version_id) survives untouched.

alter table pdm.versions
  alter column author_id drop not null;

do $$
begin
  alter table pdm.versions
    drop constraint if exists versions_author_id_fkey;
end
$$;

alter table pdm.versions
  add constraint versions_author_id_fkey
  foreign key (author_id) references auth.users(id) on delete set null;
