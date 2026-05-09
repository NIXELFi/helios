# @helios/pdm-supabase

Supabase project that backs the Helios Vault module. Holds the `pdm` schema migrations, RLS policies, RPCs, storage bucket config, and integration tests.

## Local development

1. Install Supabase CLI: `brew install supabase/tap/supabase-beta`.
2. Start Docker Desktop.
3. From this directory: `pnpm db:start`. First run takes ~2 minutes.
4. Print local credentials: `pnpm db:status`. Copy the `anon key` and `service_role key` into `.env` (use `.env.example` as a template).
5. Run integration tests: `pnpm test`.
6. Reset the database (re-applies all migrations from scratch): `pnpm db:reset`.
7. Stop the local stack: `pnpm db:stop`.

## Production deploy

1. `supabase link --project-ref <ref>` against the live project.
2. `supabase db push` to apply migrations.
3. Run `pnpm bootstrap:admin -- --email <email>` once to create the first admin.

The bootstrap script is the only one-shot procedure; everything else is migration-driven.

## Layout

| Path | Purpose |
| --- | --- |
| `supabase/migrations/` | Append-only SQL migrations |
| `supabase/config.toml` | Supabase CLI local config |
| `tests/` | Vitest integration tests against the local Supabase |
| `scripts/bootstrap-admin.ts` | One-shot admin promoter |
