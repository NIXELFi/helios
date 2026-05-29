# Modules: Vault & Logs

Helios has two top-level modules, switched via the 56-px left rail (`ModulePicker`). Modules are mount-once: the first time you visit one, it loads; switching tabs after that just toggles visibility, preserving in-memory state.

## Logs

The default module and the one most users live in — telemetry analysis.

Everything covered elsewhere in this wiki happens inside Logs:

- [App tour](02-app-tour.md) — header, sidebar, modals
- [Workspaces & tiles](03-workspaces-and-tiles.md) — layouts, edit mode
- [Widgets reference](04-widgets-reference.md) — every widget
- [Channels & data](05-channels-and-data.md) — CSV ingest
- [Math channels](06-math-channels.md) — computed channels
- [Laps & analysis](07-laps-and-analysis.md) — detection, reports
- [Keyboard & commands](08-keyboard-and-commands.md) — ⌘K + hotkeys

Implementation: [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx).

## Vault

A multi-user file storage system backed by Supabase. Introduced as "Phase 1" in v3.0.0 and marked **NEW** on the module rail.

The Vault stores session files, telemetry logs, share bundles, and analysis sessions with **version control**, **file locking**, and **role-based access control**.

### Connection (bring-your-own Supabase)

As of v3.7.0 there's **no baked-in Supabase connection**. Each user enters their
project's URL + anon key once via the sidebar **Sign in → Connect** step; it's
stored in `localStorage` (the anon key is public — RLS enforces access). The
old `VITE_SUPABASE_*` env vars are gone from the shipped app. This means anyone
running their own copy of the Helios PDM backend (the `infra/pdm-supabase`
migrations + matching auth config) can point Helios at it.

### Accounts

Auth is app-wide (the `AuthShell` wraps the whole window, not just Vault):

- **Sign up / sign in** from the persistent sidebar user pill. Sign-up requires
  a **display name** and a **subteam** (the list lives in `pdm.subteams`,
  managed by admins — not hard-coded). Self-signup is enabled.
- **Roles**: `owner` > `admin` > `editor` > `viewer`. Reads are open to any
  member; writes need editor+; role management is owner/admin via the in-app
  **Admin** screen (hybrid: only the owner grants the admin role).
- **Passwords**: change-password from the user-pill dropdown; forgot-password
  via a 6-digit email OTP (Resend SMTP). No magic-link redirect — codes work on
  desktop.
- The Vault button is greyed out until signed in; Logs + CFD work logged-out.
  Sessions persist via Supabase's `auth.persistSession: true`.

### Screens

The Vault is divided into screens, switched via its own `NavRail` (the **Admin**
screen appears only for admins):

1. **Browse** — Folder/file tree with multi-select. Each file row shows latest-version metadata, lock status, and local-sync state. An **UnmatchedFilesBanner** offers bulk "Add all" or per-file "Add" actions when local files exist that aren't in the vault.
2. **History** — Per-file version timeline with author, comment, size, SHA256, and "Restore to working copy" actions.
3. **Who has what** — Active checkouts. A table of file × holder × acquired-at. Admins get a **Force unlock** button (with a reason prompt) on any row.
4. **Settings** — Signed-in email & role (read-only), local vault folder picker (via Tauri's `openDirDialog`), and a sign-out button.

### Local sync

The Browse screen auto-scans the local vault folder using a native filesystem watcher plus a 30-second interval rescan, with a paused state during active sync. `useAutoSync()` runs background passes:

1. Pull latest versions from Supabase.
2. Compare SHA256 against local files.
3. Upload locally-modified files (if the user holds a lock).
4. Download remotely-added files.

### Data model

Living in the Supabase `pdm` schema:

| Table | Fields |
| --- | --- |
| **Vault** | id, name, created_at, created_by |
| **Folder** | id, vault_id, parent_id, name |
| **VaultFile** | id, vault_id, folder_id, name, latest_version_id |
| **Version** | id, file_id, version_num, sha256, size_bytes, author_id, comment, parent_version_id |
| **Lock** | id, file_id, user_id, acquired_at, released_at, force_released_by |

### Custom hooks

Vault's data layer is `~25` custom hooks under [`apps/desktop/src/modules/vault/data/`](../../apps/desktop/src/modules/vault/data/), all returning a uniform `QueryResult<T> = { data, loading, error, refetch }`:

- `useVaults()`, `useFolders()`, `useFiles()` — hierarchical browse.
- `useLatestVersions()`, `useVersions()` — version history.
- `useLocks()`, `useAcquireLock()`, `useReleaseLock()`, `useForceUnlock()` — concurrency.
- `useAllFiles()`, `useLocalFolderScan()` — sync state.
- `useAutoSync()` — background pull/push.
- `useCreateVault()`, `useCreateFolder()`, `useCreateFile()`, `useDeleteFile()`, `useCheckIn()` — mutations.
- `useMyRole()`, `useIsAdmin()` — permissions.

### Authentication package

The auth logic lives in [`packages/auth/`](../../packages/auth/):

- **`SupabaseAuthProvider`** — context provider; accepts a `client` that may be `null` (no connection yet) and subscribes to `client.auth.onAuthStateChange`.
- **`useUser()`**, **`useSession()`**, **`useAuthLoading()`**, **`useSupabaseClient()`**, **`useSupabaseClientOrNull()`** — hooks.
- **`createSupabaseClient({ url, anonKey })`** — takes the connection explicitly (sourced from the in-app Connect step / `localStorage`, not env). Sets `db.schema: "pdm"` so Vault tables resolve correctly.
- The desktop app's **`AuthShell`** (`apps/desktop/src/auth/`) owns the connection + builds the client; `AuthModal` handles connect / sign-in / sign-up / forgot-password.

### Palette unification

Vault originally shipped with generic zinc/shadcn tokens. Commit `c5929a5` unified its palette with Logs by replacing them with Helios design tokens (`helios-base`, `helios-panel`, `helios-line`, `helios-text`, `helios-dim`, `asu-gold`, `asu-maroon`). Both modules now feel like one app.

## Backend wiring

Logs talks to local files only — CSV ingest goes through Tauri `commands/load_csv.rs` and the channel store. No network calls.

Vault talks to Supabase from the browser (HTTPS + WebSocket), using the auth client. There are no Tauri commands for vault data — only for local filesystem operations (folder pick, file read/write for sync).

## Future cross-module links

There's no in-app routing from Logs to Vault yet (e.g. "Open this file in Vault"). The plan is to add deep-links once both modules are stable.

## Reference files

| File | Role |
| --- | --- |
| [`apps/desktop/src/Shell.tsx`](../../apps/desktop/src/Shell.tsx) | Module mount/switch logic. |
| [`apps/desktop/src/shell/ModulePicker.tsx`](../../apps/desktop/src/shell/ModulePicker.tsx) | Left-rail tab UI. |
| [`apps/desktop/src/modules/vault/`](../../apps/desktop/src/modules/vault/) | Vault module root. |
| [`packages/auth/`](../../packages/auth/) | Auth provider + hooks. |
| [`infra/pdm-supabase/`](../../infra/pdm-supabase/) | Supabase schema and tests (CI-skipped without credentials). |
