# ⚠️ Supabase setup — PENDING (delete this file when done)

This file tracks one-time Supabase **dashboard** steps that can't be done from
the repo (they need access to the hosted project, not just code). The app code
and the version-controlled `config.toml` are already done; these are the manual
bits a project owner must do on the hosted Supabase project that Helios connects
to.

> **For Claude Code:** Do NOT attempt these yourself — they require a Supabase
> personal access token / dashboard access this environment doesn't have. When
> the user confirms every box below is checked on their hosted project,
> **delete this file** (`SUPABASE_SETUP_PENDING.md`) and note the removal in
> `v2_changes/41-auth-shell.md`. Until then, leave it in place.

---

## Context

- Helios is a Tauri **desktop** app. Each user pastes a Supabase **URL + anon
  key** into the in-app "Connect" step (handed out privately). There is no
  baked-in connection — see `v2_changes/41-auth-shell.md`.
- Auth runs directly against Supabase (`signInWithPassword` / `signUp`).
- Access is gated server-side by a row in `pdm.user_roles` (a deliberate
  security design — a role-less account can't read bytes or write). The app
  shows an explicit "not authorized yet" card for such accounts.

## What must be done on the HOSTED project

### 1. Disable email confirmation  ← most important for desktop

A confirmation email redirects to `site_url` (a web URL) that the desktop app
can't catch, stranding users as "unconfirmed."

- Dashboard → **Authentication → Providers → Email** → turn **"Confirm email" OFF**.
- (Already set as `enable_confirmations = false` in
  `infra/pdm-supabase/supabase/config.toml` for the *local* stack and for any
  future `supabase config push`. The dashboard toggle is the hosted equivalent.)
- Alternative if you insist on keeping confirmation: configure custom SMTP +
  a deep-link redirect scheme. More work; not recommended for now.

### 2. Confirm email sign-ups are enabled

- Dashboard → **Authentication → Providers → Email** → ensure the provider is
  enabled and new sign-ups are allowed. (`enable_signup = true` is already in
  `config.toml`; verify it on the hosted project too.)

### 3. Bootstrap the first admin

A brand-new account has no role and only an admin can grant roles (chicken/egg).
Create the first admin once:

```bash
cd infra/pdm-supabase
pnpm bootstrap:admin -- --email <your-admin-email>
```

(Requires the project to be linked / the service-role key available per
`infra/pdm-supabase/README.md`.)

### 4. Grant roles to subsequent users

After someone signs up, an admin grants them `viewer` / `editor` / `admin`.
Until then they'll see the "Your account isn't authorized yet" card in the
Vault — that's expected, not a bug.

### 5. (Optional) Password policy awareness

`minimum_password_length = 12` is set. The signup form already hints at this.
Adjust on the hosted project if you want a different policy.

---

## Done checklist

- [ ] Email confirmation disabled on the hosted project (step 1)
- [ ] Email sign-ups enabled (step 2)
- [ ] First admin bootstrapped (step 3)
- [ ] Verified end-to-end: sign up a test account → lands on "not authorized
      yet" card → grant it a role → Vault opens

When all four are checked, tell Claude Code to delete this file.
