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

### Requirements

Vault needs Supabase credentials baked into the build via Vite env vars:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

If unset, opening the Vault tab shows an "auth not configured" message. Production builds in CI inject these via repo secrets.

### Sign-in

Unauthenticated users see the **LoginPane**: email + password form. `client.auth.signInWithPassword({ email, password })` against Supabase; the auth provider listens for `onAuthStateChange` and re-renders the rest of the module once `SIGNED_IN` fires. Sessions persist via Supabase's `auth.persistSession: true` (localStorage; Tauri can tighten to OS keychain in a future build).

### Screens

The Vault is divided into four screens, switched via its own `NavRail`:

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

- **`SupabaseAuthProvider`** — context provider; subscribes to `client.auth.onAuthStateChange`.
- **`useUser()`**, **`useSession()`**, **`useAuthLoading()`**, **`useSupabaseClient()`** — hooks.
- **`RequireAuth`** — HOC that renders a loading state, then the login pane if unauthenticated, then children once signed in.
- **`createSupabaseClient()`** — reads from explicit args, then `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Sets `db.schema: "pdm"` so Vault tables resolve correctly.

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
