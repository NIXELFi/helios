# 43 — Password management + transactional email (Resend)

**Date:** 2026-05-29

Adds the full password lifecycle and wires the Supabase project to a real
email provider so it works for actual users, not just the dashboard owner.

## App

- **Change password (logged in)** — `auth/ChangePasswordModal.tsx`, reached from
  the sidebar user-pill dropdown ("Change password…"). New password + confirm,
  12-char minimum guard, `client.auth.updateUser({ password })`.
- **Forgot password via email OTP** — new "Forgot password?" path in the auth
  modal: enter email → `resetPasswordForEmail` sends a numeric code → enter
  code + new password → `verifyOtp({ type: 'recovery' })` then
  `updateUser({ password })`. Deliberately **OTP, not magic-link**: a desktop
  app has no web server to catch a magic-link redirect, so a typed code is the
  durable approach. Code validation accepts 4–10 digits so it survives a
  project whose `mailer_otp_length` differs from ours.
- Both flows mounted at the Shell level so they fire over any module.

## Supabase project config (applied via Management API)

- **Email confirmation OFF** (set earlier) — a confirmation redirect can't be
  caught on desktop; signup returns a session immediately.
- **Recovery email** retargeted from a magic link to a **6-digit OTP**
  (`mailer_otp_length = 6`) with a branded Helios HTML template
  (`mailer_templates_recovery_content`).
- **Custom SMTP via Resend** — `smtp.resend.com:465`, sender
  `helios@sundevilmotorsports.com` (verified domain), rate limit raised from
  the built-in 2/hr to 30/hr. This replaces Supabase's throttled, test-only
  built-in mailer with production-grade delivery to any address.

## Backend contract note (for self-hosters)

The OTP reset flow assumes the project's recovery template emits `{{ .Token }}`
and that SMTP is configured. A project left on the default magic-link template
or with no SMTP won't deliver usable reset codes. These are project-config
steps, not app code.

## Tests

`tests/ChangePasswordModal.test.tsx` (5) + forgot/reset cases in
`tests/AuthModal.test.tsx`: OTP request → verify → update happy path, length
validation, mismatch, server-error surfacing.

> Security: a Supabase service-role key, a personal access token, and the
> Resend API key were used in-session to configure this — all should be
> rotated (Dashboard → Settings → API; Account → Access Tokens; Resend → API
> Keys).
