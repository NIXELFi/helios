# 41 — App-wide auth shell + user creation system

**Date:** 2026-05-27

Phase 1 of the user-account system. Authentication is lifted out of the Vault module and made a first-class, app-wide concern: a persistent sidebar pill, a single auth modal, and a user-configurable Supabase connection so people outside the ASU SDM team can point Helios at their own Supabase project.

This is the foundation for Phase 2 (storing workspaces / CFD configs in the Vault under a user's namespace), which is **not** part of this change.

## What

### Supabase connection is now user-configurable at runtime

Previously the Supabase URL + anon key were baked in at build time via `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Now:

- The user enters URL + anon key in-app (the "Connect" step of the auth modal). Stored in `localStorage` under `helios:supabase-connection`. The anon key is designed to be public (Supabase enforces access via RLS), so localStorage is appropriate.
- Resolution order at boot (`resolveBootConnection`): localStorage → `VITE_*` env vars (kept as a fallback so the SDM team's existing `.env.local` dev/CI flow is unchanged) → no connection.
- Anyone with their own Supabase project + the right schema can now use Helios Vault by pasting their own URL + key. Whether their backend is set up correctly (RLS, vault tables) is their concern, not Helios's.

### App-wide auth provider

- `SupabaseAuthProvider` (`packages/auth`) now accepts `client: SupabaseClient | null`. When null it reports no session / no user / `loading: false` instead of throwing, so the provider can stay mounted before a connection exists.
- New `useSupabaseClientOrNull()` hook for components that must render while disconnected; `useSupabaseClient()` still throws if called without a client (fast-fail for code that assumes one).
- `@helios/auth` re-exports the `Session` / `SupabaseClient` / `User` types so host apps don't need `@supabase/supabase-js` in their own `package.json` just for type imports.
- New `apps/desktop/src/auth/AuthShell.tsx` wraps the entire Shell. It owns the connection state, (re)creates the Supabase client when the connection changes, and exposes `useConnection()` (connection + `setConnection` + `disconnect`) and `useHeliosAuth()` (`hasConnection` / `user` / `loading` / `client`). `userDisplayName()` prefers `user_metadata.display_name`, falls back to the email local-part.

### Sidebar auth chrome (`ModulePicker`)

- New **user pill** between the nav buttons and the UpdatesPill footer:
  - Logged out → "Sign in" pill → opens the auth modal.
  - Logged in → display name (or email) + dropdown with **Sign out** and **Disconnect Supabase** (forget the saved URL/key).
- **Vault button greys out** when no user is signed in (`aria-disabled`, muted styling, "Sign in to use Vault" tooltip). It stays *clickable* — clicking routes to the auth modal rather than navigating (per product decision). Logs + CFD remain fully usable logged-out.

### Auth modal (`apps/desktop/src/auth/AuthModal.tsx`)

Two layers in one dialog so nothing is lost when flipping between them:

1. **Connect** — Supabase URL + anon key (skipped if a connection is already saved; reachable later via "Change Supabase connection…").
2. **Sign in / Sign up** — email + password. Self-signup is enabled; sign-up also collects an optional **display name** stored in `user_metadata.display_name`. Handles the email-confirmation case (account created but no session → "check your email" notice).

### Shell wiring

- `Shell.tsx` default export is now `ShellRoot` = `<AuthShell><HeliosShell/></AuthShell>`.
- Vault only mounts when `user !== null`; if the user signs out while on Vault, the Shell bounces them back to Logs.
- `UpdateModal` + `AuthModal` both mounted at the shell level so they fire over any module.

### Vault module slimmed

- `modules/vault/index.tsx` no longer does auth gating (the Shell does). It only renders a "Loading…" notice until `getSession()` resolves, then `VaultHome`.
- The old `LoginPane` (`modules/vault/LoginPane.tsx`) + its test are deleted — auth lives in the sidebar modal now.

## Tests

- `packages/auth/tests/provider.test.tsx` — unchanged, still green (the null-client path is additive).
- `tests/ModulePicker.test.tsx` — new assertions: Sign-in pill calls `onOpenAuth`; logged-in pill shows the label + Sign out / Disconnect menu items; Vault greys out (`aria-disabled`) but still fires `onSelect` when disabled.
- `tests/auth-shell-routing.test.tsx` — rewritten for the modal flow: boots to Logs with the modal closed + a Sign-in pill present; clicking the greyed Vault button opens the auth dialog.
- `tests/VaultModule.test.tsx` — the "shows LoginPane" case is replaced by "shows a loading notice while the session resolves".
- `tests/AuthModal.test.tsx` (new) — Connect-step validation, advancing to Sign-in, starting on Sign-in when already connected, `signInWithPassword` wiring, display-name → `signUp` metadata, and surfacing a sign-in error.

499 desktop tests + 9 auth-package tests pass; `tsc --noEmit` clean.

## Not in scope (Phase 2)

Uploading workspaces / CFD configs to the Vault under the user's namespace, module-specific vault views, and the opt-in upload UX. The default remains "nothing is uploaded."

## Follow-up — fully decouple the shipped binary from the repo's Supabase

The initial Phase 1 still kept the `VITE_SUPABASE_*` env vars as a boot fallback, and CI injected the SDM project's values from repo secrets at release-build time. That meant the shipped binary defaulted to one specific Supabase project baked in from the GitHub repo — which undercuts the whole point of a per-user connection. Removed:

- `resolveBootConnection()` (`apps/desktop/src/auth/connection.ts`) is now **localStorage-only** — no env-var fallback. The shipped app starts knowing about no Supabase project; the user enters URL + anon key via the Connect step (persisted locally, entered once per machine).
- `.github/workflows/release.yml` no longer injects `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. The release build is decoupled from any Supabase project.
- `apps/desktop/.env.example` rewritten to explain the connection is configured in-app, not via env.

Note: auth itself was always direct-to-Supabase (`supabase.auth.signInWithPassword` / `signUp`); GitHub was only ever the source of the *default connection credentials*. This change removes that default. `@helios/auth`'s `createSupabaseClient()` keeps its env-var resolution path for the package's own tests / non-desktop consumers, but the desktop app never relies on it (AuthShell always passes explicit `{ url, anonKey }`).

Consequence: the SDM team now also enters the URL + key once on first launch rather than getting it pre-baked — the intended trade for a per-user, bring-your-own-Supabase model.

## Follow-up — legible "not authorized yet" state + signup hint

Once the connection is user-supplied, the next rough edge is what a *brand-new* signup sees. The storage RLS (migration `20260511000700`, a deliberate CRITICAL security fix) means a user with **no row in `pdm.user_roles`** can list folder/file names but cannot download bytes or write anything. Without explanation that reads as a broken, empty vault. Added:

- `apps/desktop/src/modules/vault/data/useVaultAccess.ts` — resolves `loading | member | no-role | error` by looking up the caller's `user_roles` row.
- `modules/vault/index.tsx` now gates on it: a role-less account gets an explicit **"Your account isn't authorized yet — ask an admin to grant you a role"** card (with the signed-in email); a failed lookup gets a **"Couldn't verify Vault access"** card surfacing the raw error (so a self-hoster can tell "not invited" apart from "pdm schema/migrations not applied"). Members fall through to the normal `VaultHome`.
- `auth/AuthModal.tsx` — signup form notes that most Helios vaults require a 12-char password (matches `minimum_password_length` in the Supabase config), so users don't hit a cryptic "weak password" error.

Deliberately **not** done: an auto-role-on-signup trigger. That would re-open exactly the hole migration `20260511000700` closed. New accounts stay role-less until an admin grants access (`pnpm bootstrap:admin` for the first admin, then admin-managed roles thereafter).

### Supabase-side config that affects signup (not code — dashboard)

- **Email confirmation — DONE in repo**: set `enable_confirmations = false` in `infra/pdm-supabase/supabase/config.toml` (`[auth.email]`). A confirmation email redirects to `site_url` (a web URL a Tauri desktop app can't catch), which would strand users "unconfirmed"; with it off, sign-up returns a session immediately. Applies to **local** on `supabase db reset` / `start`. For the **hosted** project this lands via `supabase config push` (if you use config-as-code) **or** toggling Auth → Providers → Email → "Confirm email" OFF in the dashboard — that part can't be done from this repo (needs an authenticated CLI session / dashboard access).
- **Signups enabled**: `enable_signup = true` already set in config; confirm Auth → Providers → Email is on in the hosted dashboard too.
- **First admin**: bootstrap once via `infra/pdm-supabase` `pnpm bootstrap:admin -- --email <email>`; subsequent roles are admin-managed.

Authorization stays server-side regardless of the confirmation toggle — email confirmation was never the access gate; the `pdm.user_roles` row is.

## Files of note

- `packages/auth/src/provider.tsx`, `hooks.ts`, `index.ts` — null-client support + safe hook + type re-exports.
- `apps/desktop/src/auth/connection.ts` — localStorage connection storage + validation + boot resolution.
- `apps/desktop/src/auth/AuthShell.tsx` — connection + client owner; `useConnection` / `useHeliosAuth` / `userDisplayName`.
- `apps/desktop/src/auth/AuthModal.tsx` — connect / sign-in / sign-up dialog.
- `apps/desktop/src/shell/ModulePicker.tsx` — user pill + Vault grey-out.
- `apps/desktop/src/Shell.tsx` — `ShellRoot` wrapper + Vault gating + modal mounting.
- `apps/desktop/src/modules/vault/index.tsx` — slimmed to a loading gate.
