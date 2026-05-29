# 42 — Admin panel: owner tier + in-app role management

**Date:** 2026-05-29

Adds an admin-only "Users" screen in the Vault where roles are granted/revoked, backed by a new **owner** role tier. Permission model is hybrid: only the **owner** can grant/change/revoke the **admin** role; any **admin** can grant/revoke **editor**/**viewer**.

## Backend (migration `20260529000000_pdm_owner_role_and_admin_panel.sql`)

DML on `pdm.user_roles` is revoked from `authenticated` (migration `20260511001300`), so all role changes flow through `SECURITY DEFINER` RPCs that enforce authorization in-band.

- **`owner` role** added to the `user_roles` role check constraint.
- **`pdm.is_admin()`** now treats `owner` as admin (`role in ('owner','admin')`), so the owner has every admin power.
- **`pdm.is_owner()`** + `pdm.pdm_is_owner()` / `public.pdm_is_owner()` proxies.
- **`pdm.set_user_role(target, role)`** — grant/change a role. Rules enforced server-side:
  - `owner` is never assignable here (bootstrap-only) — prevents escalation.
  - granting `admin`, or touching an existing `admin` row, requires `is_owner()`.
  - `editor`/`viewer` on a non-admin row requires `is_admin()`.
  - can't change your own role; the `owner` row is immutable here (prevents lockout).
- **`pdm.revoke_user_role(target)`** — remove a role entirely; same tiered auth (only owner revokes an admin; owner row can't be revoked; no self-revoke).
- **`pdm.admin_list_users()`** — admin-gated; joins `auth.users` + `pdm.user_roles` so the panel can show real emails (auth.users isn't client-readable). Raises `42501` for non-admins.
- All exposed as `pdm.pdm_*` aliases (the JS client uses `db.schema = 'pdm'`) **and** `public.pdm_*` proxies; granted to `authenticated`, revoked from `anon` — matching house convention.
- **`bootstrap-admin.ts`** now grants `owner` by default (was `admin`), with an optional `--role` flag. The owner is the single super-user the model expects.

## Frontend

- **`screens/AdminScreen.tsx`** — table of every account (email, role badge, granted date) with a per-row role `<select>` + Revoke. Client mirrors the server rules for affordance: the `admin` option is disabled for non-owners; `owner`/`admin` rows are read-only to non-owners; your own row and the owner row are locked. RLS/RPC remain the real enforcement.
- **Hooks** (`data/`): `useVaultUsers` (→ `pdm_admin_list_users`), `useIsOwner` (→ `pdm_is_owner`), `useSetUserRole` (→ `pdm_set_user_role`), `useRevokeUserRole` (→ `pdm_revoke_user_role`). New `VaultRole` / `VaultUser` types.
- **NavRail** gains an **Admin** entry, appended only when `useIsAdmin()` is true (`showAdmin` prop). **VaultHome** routes to `AdminScreen` and bounces a demoted user off it.

## Tests

`tests/AdminScreen.test.tsx` (5): lists users; owner can promote a viewer to admin; a non-owner admin sees the admin option disabled + can't edit an admin row; revoke calls the RPC; your own row is locked. 506 desktop tests pass; `tsc` clean.

## Applied to hosted

Migration applied to the production project (`dlmyixonuyckxkknolku`) via the Management API SQL endpoint; `nmmurra3@asu.edu` promoted `admin → owner`; PostgREST schema cache reloaded.

> Security note: a service-role key and a personal access token were used in-session to set this up — both should be rotated (Dashboard → Project Settings → API, and Account → Access Tokens).
