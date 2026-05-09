-- The original schema migration declared `unique (vault_id, parent_id, name)`
-- on pdm.folders. In Postgres standard SQL, NULL is not equal to NULL inside
-- unique constraints — so two root folders (parent_id IS NULL) with the same
-- name in the same vault are treated as DISTINCT and the constraint allows
-- duplicates. In practice this lets `useAddLocalFile`'s race-window create N
-- copies of "CSVS" / "Link Log Files" / etc. when the user runs Add All
-- repeatedly (or during long-running concurrent ops).
--
-- Fix: add two partial unique indexes that explicitly cover both cases.
-- (Partial indexes work because the original constraint can't be retrofitted
-- to treat NULL as equal without dropping it — which we don't do because some
-- environments may have it as a constraint, not just an index.)

create unique index if not exists folders_unique_root_per_vault
  on pdm.folders (vault_id, name) where parent_id is null;

create unique index if not exists folders_unique_nested_per_parent
  on pdm.folders (vault_id, parent_id, name) where parent_id is not null;

-- We deliberately leave the original `unique (vault_id, parent_id, name)`
-- constraint in place — it serves as a backstop for non-null cases. The
-- partial index above is what actually prevents the NULL-parent duplication.
