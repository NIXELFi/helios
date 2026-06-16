# Contributing to Helios

Helios is built by Sun Devil Motorsports (Arizona State FSAE). Outside
contributions are welcome — issues, fixes, and features alike.

## Prerequisites

- **Node 20+** and **pnpm 9** (`npm install -g pnpm@9`)
- **Rust stable** via [rustup](https://rustup.rs)
- A C/C++ toolchain Rust can link against (VS 2022 Build Tools on Windows;
  Xcode CLT on macOS; `build-essential` + the Tauri GTK/WebKit packages on Linux)
- **Docker** — only if you want to run the Vault's backend integration suite

## Build & run

```bash
pnpm install
pnpm dev          # Tauri dev build with HMR (NOT a browser — the app needs the shell)
pnpm build        # release build via tauri build
```

## Tests

Run what you touched, at minimum:

```bash
pnpm typecheck                      # tsc --noEmit, every workspace package
pnpm test                           # all TS suites (pdm-supabase auto-skips without a stack)
cargo test --workspace              # all Rust tests
```

For Vault backend changes (anything under `infra/pdm-supabase/`):

```bash
cd infra/pdm-supabase
supabase start                      # local stack; applies every migration from scratch
# one-time: mark the throwaway DB as a test environment (see scripts/test-or-skip.cjs)
pnpm test
```

CI runs all of the above — including the RLS/RPC security suite against a real
local Supabase stack — on every PR.

## Releasing & the changelog

**Every user-facing change must get a bullet in `CHANGELOG.md` under
`## [Unreleased]`** (grouped Added / Changed / Deprecated / Removed / Fixed /
Security). That file is the single source of truth for release notes — the chain
is:

```
CHANGELOG.md  →  GitHub release body  →  #releases Slack channel
```

Cutting a release:

1. Add/finalize your notes under `[Unreleased]` in `CHANGELOG.md`.
2. `node scripts/bump-version.mjs <version>` — bumps the four version fields
   **and** promotes `[Unreleased]` to a dated `## [<version>]` section, leaving a
   fresh empty `[Unreleased]`.
3. Commit, then push tag `v<version>`.

The Release workflow (`.github/workflows/release.yml`) builds all platforms,
puts the `CHANGELOG.md` section into the GitHub release body, and — for stable
tags — posts it to Slack via the `SLACK_RELEASE_WEBHOOK` repo secret (the webhook
URL is never committed). `scripts/check-versions.mjs` **fails the release** if the
tag has no matching `CHANGELOG.md` section, so a missing changelog blocks the
release rather than shipping silently.

## Ground rules

- **Add your changelog entry under `[Unreleased]` in `CHANGELOG.md`** for any
  user-facing change — the release will fail without it (see above).

- **Never edit an existing migration** in `infra/pdm-supabase/supabase/migrations/`;
  the hosted database already ran them. Add a new timestamped file.
- Vault code treats the OS read-only bit as the "clean copy" marker. Any code
  path that deletes or overwrites a local file must refuse when the file is
  writable (possible unsaved work) — see `useDeletedFileReaper` for the pattern.
- Match the style of the file you're in; add tests next to the existing suites
  (`apps/desktop/tests/vault/`, `infra/pdm-supabase/tests/`, `#[cfg(test)]`).
- PRs should describe what changed and why, and call out anything you could
  not test locally (e.g. Windows-only paths).
