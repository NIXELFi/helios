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

## Ground rules

- **Never edit an existing migration** in `infra/pdm-supabase/supabase/migrations/`;
  the hosted database already ran them. Add a new timestamped file.
- Vault code treats the OS read-only bit as the "clean copy" marker. Any code
  path that deletes or overwrites a local file must refuse when the file is
  writable (possible unsaved work) — see `useDeletedFileReaper` for the pattern.
- Match the style of the file you're in; add tests next to the existing suites
  (`apps/desktop/tests/vault/`, `infra/pdm-supabase/tests/`, `#[cfg(test)]`).
- PRs should describe what changed and why, and call out anything you could
  not test locally (e.g. Windows-only paths).
