-- One role row per (user, vault) on pdm.user_roles.
--
-- Applied to dlmyixonuyckxkknolku via the Management API; this file keeps the
-- repo / a from-scratch rebuild in sync. It does NOT change the live DB.
--
-- Background: changing a member's role could create two user_roles rows (a
-- global one with vault_id null + a per-vault one). The web's useVaultAccess did
-- .maybeSingle() -> "multiple rows returned" -> a "Couldn't verify vault access"
-- lockout. A unique index (treating a null vault_id as the zero-uuid so global
-- roles also dedupe) prevents the duplicate going forward.

-- One-time cleanup so the unique index can be created. Keeps one row per
-- (user, coalesced-vault); NO-OP on a fresh build (the table is empty). Not
-- re-run against prod by this file.
delete from pdm.user_roles a
 using pdm.user_roles b
 where a.user_id = b.user_id
   and coalesce(a.vault_id, '00000000-0000-0000-0000-000000000000'::uuid)
     = coalesce(b.vault_id, '00000000-0000-0000-0000-000000000000'::uuid)
   and a.ctid < b.ctid;

create unique index if not exists user_roles_user_vault_uniq
  on pdm.user_roles (user_id, coalesce(vault_id, '00000000-0000-0000-0000-000000000000'::uuid));
