# 44 — Mandatory profile (display name + subteam) + managed subteams

**Date:** 2026-05-29

Every account now carries a display name and an SDM subteam, both mandatory at
sign-up. The subteam list is data in Supabase (not hard-coded), so owner/admins
can grow it.

## Backend (migration `20260529010000_pdm_subteams.sql`)

- **`pdm.subteams`** table (id, name unique, sort_order, created_at, created_by),
  seeded in the requested non-alphabetical order: Engine, Suspension, Driver
  Interface, Drivetrain, Brakes, Chassis, Aero Design, Aero Manufacturing,
  Operations, Finance, MarCom.
- **RLS**: `select` open to `anon` + `authenticated` — the sign-up form must
  show the list before the user is authenticated. Direct DML revoked; changes
  go through admin-gated RPCs.
- **`pdm.create_subteam` / `pdm.delete_subteam`** — SECURITY DEFINER, `is_admin`
  (owner counts) only; `pdm.pdm_*` + `public.pdm_*` proxies, authenticated-only.
- **`admin_list_users`** extended to also return `display_name` + `subteam`
  (from `auth.users.raw_user_meta_data`). Return type changed, so the trio was
  dropped + recreated.
- `bootstrap-admin.ts` already grants `owner` by default (from entry 42).

## App

- **Sign-up** now requires a display name **and** a subteam pick (populated live
  from `pdm.subteams`). Inline Helios-styled validation (the `required`
  attributes were dropped so the JS validation owns it rather than native
  browser bubbles). Both stored in `user_metadata`.
- **Admin panel** gains Name + Subteam columns and a **Subteams** management
  section (add/remove) for any admin/owner.
- **Sidebar user pill** shows a second line under the name: `subteam · ROLE`
  (role fetched at the Shell level via a new safe `useMyRole()` that degrades
  to null when logged out / disconnected).

## Applied to hosted

Migration applied to `dlmyixonuyckxkknolku` via the Management API; both
existing accounts (`nmmurra3@asu.edu`, `nick532219@gmail.com`) backfilled to
display name "Nick Murray", subteam "Engine"; schema cache reloaded.

## Tests

New `useSubteams` / `useManageSubteams` hooks; `AdminScreen.test.tsx` covers the
extended user rows; `AuthModal.test.tsx` covers mandatory display-name +
subteam at sign-up; `ModulePicker.test.tsx` covers the subteam/role line.
