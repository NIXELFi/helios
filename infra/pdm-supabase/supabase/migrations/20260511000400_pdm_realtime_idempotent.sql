-- Fix M22 from ultrareview 2026-05-11:
-- 20260509110000_pdm_enable_realtime.sql uses bare `ALTER PUBLICATION ... ADD
-- TABLE`, which raises duplicate_object on re-run (relation is already member
-- of the publication). This breaks `supabase db reset` and any rerun against
-- an environment that has already been bootstrapped.
--
-- This migration:
--   * Wraps each ADD TABLE in a DO block that swallows duplicate_object so it
--     is safe to re-run.
--   * Adds pdm.folders to the publication (was missing in 20260509110000,
--     flagged by audit).

do $$
begin
  alter publication supabase_realtime add table pdm.versions;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table pdm.locks;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table pdm.files;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table pdm.folders;
exception
  when duplicate_object then null;
end
$$;
