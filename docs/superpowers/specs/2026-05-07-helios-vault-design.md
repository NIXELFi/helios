# Helios Vault — Design Spec

**Date:** 2026-05-07
**Owner:** Sun Devil Motorsports (ASU FSAE)
**Status:** Draft for review
**Target version:** Helios 3.0 (introduces the suite-shell + first non-logs module; bump major because login becomes required and the app reframes from "logs viewer" to "Helios suite"). Do **not** tag/release as part of this work — `v*` tags trigger the GitHub Actions release pipeline.

## Summary

Helios Vault is a SolidWorks-style Product Data Management (PDM) module added to the Helios desktop suite. It is the team's central source of truth for CAD: every part, assembly, and drawing for the next car build lives in the Vault, with exclusive locking so two designers never overwrite each other, and immutable versioning so we can always answer "what changed and when."

This spec covers Phase 1 (the standalone vault — usable for the next car build, no SolidWorks add-in yet) and outlines Phases 2 and 3 at the level of detail needed to make Phase 1 architectural decisions correctly.

The Vault module is the second software package in the Helios suite. It coexists with the existing log-management module inside one desktop app, behind a single suite-wide login. On Windows, daily check-out/check-in happens primarily in File Explorer (overlay icons + right-click context menu); the in-app Vault module covers history, search, "who has what checked out," admin operations, and settings. On Mac, the Vault module is read-only — full CAD operations are Windows-only (SolidWorks is Windows-only).

The backend is Supabase Pro (managed Postgres + Storage + Auth + Realtime + Edge Functions). The decision over self-hosted AWS reflects scale: the team is ~20 users with ~10 concurrent peak, and the working CAD set is ~8 GB. Supabase covers all of that for $25/month flat with vastly less code to maintain. Supabase's open-source stack (Postgres + GoTrue + PostgREST + Realtime + Storage) is self-hostable if we ever need to bail out.

## Goals

- Single source of truth for every CAD file used to build the car.
- Exclusive locking — at most one active editor per file, enforced by the database.
- Immutable versioning with author, timestamp, and comment for every check-in.
- Native-feeling Windows experience: vault contents appear as a regular Explorer folder with overlay icons and a right-click context menu; designers don't have to leave their normal workflow to check files in/out.
- A Vault module inside the Helios desktop app for browse, history, search, "who has what," admin (force-unlock, user invite, role management), and settings.
- Suite-wide login: one user identity covers Logs, Vault, and any future Helios modules.
- Offline tolerance: a designer who has a file checked out can keep editing without network and push their work when reconnected.
- Cross-platform identity, Windows-first CAD ops: Mac users log in and read the vault; they don't check out or edit CAD files.
- Auto-track parent → child references between SolidWorks files (sufficient to power "where used").
- Cost ceiling: $25–40 / month at planning scale.

## Non-Goals (this phase)

- **No workflow engine.** No states beyond "checked-in" / "checked-out." No approval routing. No state-transition permissions. (Confirmed with team: locking is the only workflow needed.)
- **No SolidWorks add-in.** Read-only enforcement inside SolidWorks is Phase 2. In Phase 1, designers must remember to check out before editing; the OS read-only bit on non-checked-out files (set by the shell extension) is the only mechanical guardrail.
- **No BOM extraction, no eDrawings preview, no in-SW reference rewriting on rename.** All Phase 2 — they require the SolidWorks API.
- **No Mac CAD client.** Mac builds get the Vault module in read-only mode only.
- **No SSO.** Username + password via Supabase Auth in Phase 1. SSO providers are a Phase 3 enable-flag, not a code change.
- **No custom data cards / metadata schema editor.** File metadata is a fixed set in Phase 1 (name, folder, version comment, author, timestamps, lock state, refs). Custom data cards arrive in Phase 3 if real demand emerges.
- **No multi-vault.** One vault for the whole team. (The schema supports many; the UI in Phase 1 shows only one.)
- **No per-folder / per-file permissions beyond the three suite roles** (admin, editor, viewer).
- **No notifications, webhooks, activity feeds, Slack/Discord integrations.** All Phase 3.
- **No code-signing certificates.** Same policy as existing Helios — see `docs/INSTALL.md`. Users click through SmartScreen / Gatekeeper warnings on first install. Auto-update via minisign-signed Tauri bundles bypasses OS warnings on subsequent updates.

## Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  Windows machine (one MSI installs all three)                │
│                                                              │
│  ┌────────────────┐    IPC     ┌──────────────────────────┐  │
│  │ Helios.exe     │◄──────────►│ pdm-sync-daemon.exe      │  │
│  │ (Tauri/React)  │            │ (Rust, tray icon)        │  │
│  │ • Login screen │            │ • Holds session JWT      │  │
│  │ • Logs module  │            │ • Owns local cache       │  │
│  │ • Vault module │            │ • WebSocket → Supabase   │  │
│  │ • Admin UI     │            │   Realtime               │  │
│  │ • Settings     │            │ • Offline queue          │  │
│  └────────────────┘            └─────────┬────────────────┘  │
│                                          │ named pipe        │
│  ┌────────────────┐                      │                   │
│  │ explorer.exe   │◄──── COM ────────────┴──────┐            │
│  │                │                             │            │
│  │                │     ┌─────────────────────┐ │            │
│  │                │◄────┤ pdm-shell-ext.dll   │◄┘            │
│  │                │     │ (Rust + windows-rs) │              │
│  └────────────────┘     │ • Overlay icons     │              │
│                         │ • Context menu      │              │
│                         │ • Delegates to daemon│             │
│                         └─────────────────────┘              │
│                                                              │
│  Local cache: %LOCALAPPDATA%\Helios\Vault\<vault-name>\      │
│   ├── working/      ← actual files designers edit            │
│   └── meta.sqlite   ← local mirror of file/lock state        │
└──────────────────────────────────────────────────────────────┘
                              │ HTTPS / WSS
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Supabase project: helios-pdm                                │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Postgres (schema: pdm)                              │     │
│  │ • vaults / folders / files / versions / locks /     │     │
│  │   refs / audit_log                                  │     │
│  │ • RLS policies for permissions                      │     │
│  │ • RPC: pdm.check_in, pdm.force_unlock, …            │     │
│  │ • Triggers: audit log, refs invalidation            │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ Storage        │  │ Auth (GoTrue)│  │ Realtime        │   │
│  │ vault-objects/ │  │ password+JWT │  │ pdm.locks       │   │
│  │  <sha2[0:2]>/  │  │              │  │ pdm.versions    │   │
│  │  <sha256>      │  │              │  │ change feed     │   │
│  │ (immutable)    │  │              │  │                 │   │
│  └────────────────┘  └──────────────┘  └─────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Edge Function: parse-refs (Deno + WASM)             │     │
│  │ Triggered by Postgres webhook on version insert     │     │
│  │ Downloads bytes → runs pdm-sw-parser.wasm →         │     │
│  │ inserts into pdm.refs                               │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

Mac client is the same picture without the shell extension and sync daemon. The Helios desktop app on Mac reaches Supabase directly via the JS client, shows the Vault module in read-only mode, and disables every check-out/check-in control with an explanatory tooltip.

---

## Repo layout (within the existing helios monorepo)

Everything new is prefixed `pdm-` so the boundary is unambiguous.

```text
helios/
├── apps/
│   ├── desktop/                  ← existing Helios app, gains Vault module + login
│   ├── pdm-shell-ext/            ← Windows shell extension (Rust + windows-rs)
│   └── pdm-sync-daemon/          ← Windows tray service: cache, sync, IPC
├── crates/
│   ├── helios-arrow              ← existing
│   ├── helios-core               ← existing
│   ├── helios-csv                ← existing
│   ├── pdm-core/                 ← Vault, File, Version, Lock, Ref types; usable in WASM
│   ├── pdm-client/               ← supabase-rs wrapper; used by daemon + Tauri side
│   └── pdm-sw-parser/            ← .sldasm/.sldprt CFB parser → WASM
├── packages/
│   ├── lib                       ← existing
│   ├── store                     ← existing
│   ├── ui                        ← existing
│   ├── widgets                   ← existing
│   ├── auth/                     ← Supabase JS wrapper, useUser/useSession hooks
│   └── pdm-ui/                   ← React components for the Vault module
├── infra/
│   └── pdm-supabase/             ← migrations/, policies/, functions/parse-refs/, README
└── docs/
    └── superpowers/specs/2026-05-07-helios-vault-design.md   ← this file
```

`pnpm-workspace.yaml` already globs `apps/*` and `packages/*`, so the new apps and packages get picked up automatically. The Cargo workspace `members` array in the root `Cargo.toml` needs three new entries (`crates/pdm-core`, `crates/pdm-client`, `crates/pdm-sw-parser`) plus the `src-tauri` directories of any new Tauri apps.

The shell extension and sync daemon are Windows-only Cargo crates. Their CI builds skip on macOS/Linux runners.

---

## Backend — Supabase

### Postgres schema (under the `pdm` schema)

```sql
create schema if not exists pdm;

-- Vaults: top-level containers. Phase 1 has exactly one row.
create table pdm.vaults (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz default now(),
  created_by uuid references auth.users not null
);

-- Folder tree inside a vault.
create table pdm.folders (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid references pdm.vaults on delete cascade not null,
  parent_id uuid references pdm.folders on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  unique (vault_id, parent_id, name)
);

-- Logical file. Versions hang off this. `latest_version_id` is a denormalized
-- pointer to the most-recent version for fast browse queries.
create table pdm.files (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid references pdm.vaults on delete cascade not null,
  folder_id uuid references pdm.folders on delete cascade,
  name text not null,
  latest_version_id uuid,
  created_at timestamptz default now(),
  unique (folder_id, name)
);

-- Immutable versions. Content lives in Storage; this row records metadata.
create table pdm.versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references pdm.files on delete cascade not null,
  version_num int not null,
  sha256 text not null,                            -- storage path: <sha[0:2]>/<sha>
  size_bytes bigint not null,
  author_id uuid references auth.users not null,
  comment text,
  parent_version_id uuid references pdm.versions,  -- the version this was based on
  created_at timestamptz default now(),
  unique (file_id, version_num)
);

-- One active lock per file enforced by partial unique index.
create table pdm.locks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references pdm.files on delete cascade not null,
  user_id uuid references auth.users not null,
  acquired_at timestamptz default now(),
  released_at timestamptz,
  force_released_by uuid references auth.users
);
create unique index one_active_lock_per_file
  on pdm.locks (file_id) where released_at is null;

-- Parent → child references parsed from .sldasm/.sldprt by the edge function.
create table pdm.refs (
  parent_version_id uuid references pdm.versions on delete cascade not null,
  child_path_hint text not null,             -- raw path string from the SW file
  child_file_id uuid references pdm.files,   -- resolved if matched within the vault
  primary key (parent_version_id, child_path_hint)
);

-- Audit log: every state-changing op.
create table pdm.audit_log (
  id bigserial primary key,
  user_id uuid references auth.users,
  action text not null,                      -- 'check_out', 'check_in', 'force_unlock', etc.
  target_type text not null,                 -- 'file', 'version', 'vault', 'user'
  target_id uuid not null,
  payload jsonb,
  ts timestamptz default now()
);

-- Roles. We store as a separate table rather than `auth.users.raw_user_meta_data`
-- so RLS policies can reference role with a JOIN rather than parsing JSON.
create table pdm.user_roles (
  user_id uuid primary key references auth.users on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  granted_at timestamptz default now(),
  granted_by uuid references auth.users
);
```

### Row Level Security policies (in plain English)

- **Read access:** any authenticated user can read every row in `pdm.vaults`, `pdm.folders`, `pdm.files`, `pdm.versions`, `pdm.refs`, `pdm.audit_log`, `pdm.locks`. (Single-team app; no read partitioning.)
- **Insert into `pdm.versions`:** only allowed if the caller holds the active lock on that `file_id`. Enforced by an RLS check that joins to `pdm.locks` with `released_at is null and user_id = auth.uid()`.
- **Insert into `pdm.locks`:** any editor or admin. Uniqueness enforced by the partial unique index, not RLS.
- **Update `pdm.locks` (release):** allowed if `auth.uid()` matches the lock's `user_id`, OR the caller is an admin (force-release path).
- **Insert/delete `pdm.vaults`, `pdm.folders`, `pdm.files`, `pdm.user_roles`:** admin only.

### Postgres RPCs (called by the client; defined as `security definer` functions)

- `pdm.check_in(file_id uuid, sha256 text, size bigint, comment text) returns versions` — atomically: assert caller holds the lock, insert into `versions` with `version_num = max+1`, update `files.latest_version_id`, set `locks.released_at = now()`, write audit row. Returns the new version row.
- `pdm.force_unlock(lock_id uuid, reason text) returns void` — admin-only. Sets `released_at = now()` and `force_released_by = auth.uid()`. Writes audit row.
- `pdm.cancel_checkout(file_id uuid) returns void` — releases the caller's lock without creating a new version. Audit row records cancellation.
- `pdm.invite_user(email text, role text) returns void` — admin-only. Calls Supabase Auth admin API to send invite, inserts `pdm.user_roles` row.

### Realtime channels

- `pdm.locks` row changes → broadcast to all connected clients. Drives the live "who has what" view in the Vault module and the overlay icons in Explorer.
- `pdm.versions` inserts → drive the in-app activity surface ("a new version of `frame.sldprt` was checked in by Alex 30 seconds ago").

### Edge Function: `parse-refs`

- Trigger: Postgres webhook on `pdm.versions` insert where the file extension is `.sldasm` or `.sldprt`.
- Runtime: Deno (Supabase's edge function runtime).
- Logic: download the version's bytes from Storage; pass to a WASM-compiled `pdm-sw-parser`; insert resulting `(parent_version_id, child_path_hint)` rows into `pdm.refs`. Best-effort: if the parser can't read the file (corrupt, unknown SW version), log to `pdm.audit_log` with `action='parse_refs_failed'` and move on.
- Resolution of `child_file_id` happens in a follow-up SQL pass: for each new ref row, attempt to match `child_path_hint`'s basename against `pdm.files.name` within the same vault. Multiple matches are left unresolved; admins can resolve manually in Phase 1, automatically in Phase 2 via the SolidWorks API.

### Storage layout

- Bucket: `vault-objects` (private — access via signed URLs only).
- Path: `<sha256[0..2]>/<sha256>` — content-addressed, deduplicated, immutable.
- Upload: client requests a signed upload URL via the JS client, PUTs the bytes, then calls `pdm.check_in` with the sha256. The RPC verifies the object exists in Storage before inserting the version row (idempotency check; duplicate uploads of identical bytes are free).
- Download: signed URL with a short TTL (5 minutes), generated on demand by the client when a designer "Get Latest"-s a file.

---

## Suite-wide identity & login

Both the existing Logs module and the new Vault module share one Supabase Auth user table.

### Roles

- **admin** — manage users, force-unlock, create/delete vaults / folders / files, configure settings.
- **editor** — check files in/out, create files, browse history, view audit log.
- **viewer** — read-only across the suite.

The existing Logs module ignores roles in Phase 1 (any logged-in user can use Logs). Roles only gate Vault operations for now.

### Bootstrap admin

The first admin is **nick532219@gmail.com** (project owner). Bootstrap procedure:

1. Create the Supabase project and run the migrations in `infra/pdm-supabase/migrations/`.
2. Run a one-off SQL script (`infra/pdm-supabase/bootstrap-admin.sql`) against the project that:
   - Inserts the user via Supabase Auth admin API (or instructs the owner to sign up first, then promotes).
   - Inserts a row into `pdm.user_roles` with `role = 'admin'`.
3. From there, all subsequent user invites happen through the Helios admin UI.

### Login flow

1. App starts → Helios shell checks for a stored refresh token in the OS keychain (Windows Credential Manager / macOS Keychain).
2. Valid token → silently refresh → land on the user's last-used module.
3. No token / expired → present the login screen (email + password, "Remember me" toggle).
4. Login success → store refresh token in keychain → land on home view.

### Offline login

The sync daemon caches the last-validated JWT plus an Argon2id hash of the user's password (with random salt, stored in `meta.sqlite`).

- Launch offline + valid cached JWT → enter "limited offline session." Logs module is fully functional. Vault module operates in offline mode: existing checked-out files remain editable; no new lock acquisitions; queued check-ins flush on reconnect.
- Launch offline + expired JWT → prompt for password → if it matches the cached hash, enter limited offline session. Same behavior.
- Online reconnect → daemon revalidates with Supabase → upgrades to a real session.

### Session state in the codebase

- **JS side:** `packages/auth/` exports a `SupabaseAuthProvider`, `useUser()`, `useSession()`, and a `RequireAuth` route guard. The Helios `apps/desktop/src/App.tsx` wraps everything in `<SupabaseAuthProvider>` and gates the module router behind `<RequireAuth>`.
- **Rust side (sync daemon):** the daemon doesn't have its own login UI. At app startup, the Tauri-side `helios.exe` performs the auth flow, then hands the daemon a session token via local IPC (named pipe). The daemon stores the token in memory + keychain and refreshes it on its own thereafter. If the daemon starts before Helios (e.g., on Windows boot), it tries the keychain first; if no stored token, it idles and the shell extension shows a "sign in to Helios" overlay state.

---

## Windows client — three binaries

### `apps/desktop` (the Helios app, gains login + Vault module)

The existing Tauri shell becomes a suite shell. Top-level structure:

```
src/
  App.tsx              ← top-level: SupabaseAuthProvider + RequireAuth + Module router
  modules/
    logs/              ← existing logs UI moves here (current src/* mostly relocates)
    vault/             ← new Vault module
  shell/
    LoginScreen.tsx    ← login + offline-login UI
    ModulePicker.tsx   ← left rail: Logs / Vault
    Settings.tsx       ← suite-wide settings (account, sign out)
```

Vault module screens (Phase 1):

- **Browse** — folder tree on the left, file table on the right. Columns: name, latest version, modified-by, modified-at, lock state, lock-holder, lock-age. Live updates via Realtime.
- **File detail** — when a file is selected, panel on the right shows: latest preview (if cached locally), full version history (newest first), parent assemblies (where used) and children (refs out), audit trail.
- **History viewer** — full version list with author, comment, timestamp, size, sha256. "Open this version" downloads it to a side-by-side compare folder (read-only). "Restore this version" creates a new version from the old bytes (audit-logged as a restore).
- **Search** — filename + comment substring across the vault. Phase 1 = simple Postgres `ILIKE`. Vector search etc. is out of scope.
- **Who has what** — flat list of all currently-locked files, grouped by holder. Admin "Force unlock" button on each row.
- **Admin → Users** — list, invite, change role, deactivate. Admin only.
- **Admin → Vaults** — Phase 1 has one vault, but admins can rename it.
- **Settings** — sign out, change password, configure local cache path, daemon status.

### `apps/pdm-sync-daemon` (Windows tray service)

A long-running Rust process that owns the local working copy and is the source of truth on-machine for vault state. Started on Windows boot (registers an HKCU\Run entry during install) or on first launch of Helios. Tray icon shows sync status.

Responsibilities:

- Hold the active Supabase session (refresh tokens automatically).
- Maintain the local cache: `working/` directory with actual files, `meta.sqlite` with file metadata mirror.
- Subscribe to Supabase Realtime for `pdm.locks` and `pdm.versions` changes; update `meta.sqlite` and notify any consumers.
- Service IPC requests from `helios.exe` (Vault module operations) and `pdm-shell-ext.dll` (overlay state, context-menu actions).
- Manage the offline queue: serialize pending check-ins to disk; flush in order when network returns.
- Run integrity checks on launch: verify each cached file's sha256 matches the version metadata it claims to be.

IPC uses Windows named pipes with a small framed JSON-RPC protocol. Daemon endpoint: `\\.\pipe\helios-pdm`. Authentication via per-session token (stored in a secure-by-default user-only file at `%LOCALAPPDATA%\Helios\daemon-auth.json`); both Helios and the shell extension read it at startup and present it on every IPC call.

The daemon is implemented in `crates/pdm-client` (the actual logic) plus a thin `apps/pdm-sync-daemon/src/main.rs` wrapper that hosts it.

### `apps/pdm-shell-ext` (Windows shell extension)

A Rust DLL using `windows-rs` to implement two shell COM interfaces:

- `IShellIconOverlayIdentifier` — provides overlay icons. Four overlays:
  - **Latest** (subtle green check) — file matches latest version, not locked.
  - **Out-of-date** (subtle yellow arrow) — local copy is older than latest version on server.
  - **Locked-by-me** (red lock with my color) — I hold the lock.
  - **Locked-by-other** (red lock, plain) — someone else holds the lock.
- `IExplorerCommand` — provides the right-click context menu items (visible only when right-clicking inside the local Vault folder):
  - **Check Out** — only when the file is not locked.
  - **Check In…** — only when I hold the lock; opens a small Explorer-hosted dialog for the comment.
  - **Cancel Check-Out** — only when I hold the lock; confirmation dialog.
  - **Get Latest** — always available; downloads the latest version into the working copy.
  - **View History** — always available; opens the Helios Vault module focused on this file.
  - **Open in Helios Vault** — same as above, alternate entry point.

Design constraints (shell extensions are notoriously fragile because they load into `explorer.exe`):

- The DLL does **no** I/O, **no** network, **no** parsing. Every operation is a synchronous-looking IPC call to the daemon with a 1-second timeout.
- If the daemon doesn't respond within the timeout, overlay shows a neutral icon and the context menu shows a single greyed-out item: "Helios sync daemon not running."
- Overlay state lookups are aggressively cached in-process and invalidated by daemon push notifications (over the same named pipe).
- Crash-on-misuse is unacceptable; every IPC call is wrapped in a `catch_unwind`.

Installation: the MSI registers the DLL via `regsvr32` and adds the appropriate registry keys under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\` (overlays) and the file-class CLSID for the context menu.

---

## Mac client

The same Tauri build as Windows, minus the Windows-only `pdm-shell-ext` and `pdm-sync-daemon` binaries. The Helios app talks to Supabase directly via the JS client.

Vault module on Mac:

- **Browse, history, search, "who has what," audit log:** all functional.
- **Check out / check in / cancel / get latest / restore version:** all disabled with a tooltip: "CAD operations require the Windows client (SolidWorks is Windows-only)."
- **Admin operations (user invite, role change, force-unlock):** all functional. Admins can run the team from a Mac.

Future expansion: when there's demand, the Mac client can grow check-out/in for non-CAD ancillary files (CSVs, PDFs, docs). The schema and API already support it; only UI gating changes.

---

## Key flows

### Flow A — Check out a file (Explorer right-click)

1. Designer right-clicks `frame.sldprt` in the Vault folder → "Check Out."
2. Shell ext sends `lock_acquire { file_id }` over the named pipe to the daemon.
3. Daemon issues `insert into pdm.locks (file_id, user_id) values (...)` against Supabase.
   - Success → daemon receives the new lock row.
   - Conflict on `one_active_lock_per_file` → daemon receives 409; queries the existing lock to learn who holds it.
4. On success: daemon downloads the latest version's bytes from Storage (signed URL) → writes to the working copy → flips the OS read-only bit off → updates `meta.sqlite` → broadcasts an overlay-invalidation pulse to the shell ext.
5. On conflict: daemon returns `{error: "locked", holder: "Alice", since: "..."}` → shell ext shows a system tray balloon with the message.

### Flow B — Check in a file (Helios Vault module)

1. Designer clicks "Check In…" in the Vault module → enters comment in the in-app dialog.
2. Helios calls daemon IPC `version_create { file_id, comment }`.
3. Daemon hashes the local file → checks if `<sha[0:2]>/<sha>` already exists in Storage → if not, requests a signed upload URL and PUTs the bytes.
4. Daemon calls `pdm.check_in(file_id, sha, size, comment)` RPC on Supabase. The RPC atomically:
   - Verifies the caller holds the active lock.
   - Inserts a new `pdm.versions` row with `version_num = max+1`.
   - Updates `pdm.files.latest_version_id`.
   - Sets `pdm.locks.released_at = now()`.
   - Writes audit row.
   - Returns the new version row.
5. Daemon flips the working-copy file to OS read-only → updates `meta.sqlite` → broadcasts overlay invalidation.
6. Postgres webhook fires the `parse-refs` edge function asynchronously. Refs appear in `pdm.refs` within seconds. The "Where used" panel updates via Realtime.

### Flow C — Offline edit and resync

1. Online: designer checks out `frame.sldprt`. Server lock held in their name.
2. Network drops. Daemon's WebSocket disconnects; tray icon turns yellow; Helios shows an offline banner.
3. Designer continues editing in SolidWorks. The file is editable because the daemon already flipped its read-only bit when the lock was acquired.
4. Designer clicks "Check In" in Helios. The daemon stores the pending check-in (file_id, sha256, comment, local timestamp) in `meta.sqlite`. UI shows: "Queued — will sync when online."
5. Network returns. Daemon re-establishes the WebSocket. It dequeues the check-in: verify the lock is still held by the user → upload bytes → call `pdm.check_in` RPC → mark as flushed.
6. **Conflict path:** if the lock was force-released by an admin while offline, the RPC returns `{error: 'no_lock'}`. The daemon does **not** discard the local changes. UI surfaces a conflict dialog: "Your changes to `frame.sldprt` were not pushed. Admin Bob force-released your lock at 14:32 with reason 'Alex went home with the laptop.' Version 7 was checked in by Alice at 15:01. Save your local copy outside the vault and reconcile manually." Binary CAD files cannot be auto-merged.

### Flow D — Force unlock (admin)

1. Admin opens Vault → "Who has what" → sees Alex's lock on `frame.sldprt` is 8 days old.
2. Admin clicks "Force unlock" → confirmation dialog asks for a reason (free text, required).
3. Helios calls `pdm.force_unlock(lock_id, reason)` RPC.
4. RPC sets `released_at = now()` and `force_released_by = admin_user_id` on the lock row, writes audit row with the reason, returns success.
5. Realtime broadcast hits all clients including Alex's daemon (next time it reconnects). Alex's overlay flips to "Latest" (he no longer holds the lock).
6. If Alex had local edits when force-unlocked, his next check-in attempt fails with the conflict path described above.

### Flow E — Reference parsing (asynchronous)

1. New version of `chassis-assembly.sldasm` lands via Flow B.
2. Postgres trigger sends a webhook to the `parse-refs` edge function with `{version_id}`.
3. Edge function downloads the bytes via Storage signed URL → invokes the WASM-compiled `pdm-sw-parser` → receives a list of referenced part paths (e.g., `..\parts\frame-rail-front.sldprt`, `..\hardware\m6-bolt-25mm.sldprt`).
4. Edge function inserts rows into `pdm.refs (parent_version_id, child_path_hint)`.
5. A second pass (same function, before commit) attempts to resolve each `child_path_hint`'s basename against `pdm.files.name` within the same vault. Single match → set `child_file_id`. Multi-match → leave null, log to audit. No match → leave null.
6. Realtime broadcasts the `pdm.refs` change → Vault module's "Where used" / "Refs out" panels refresh.

### Flow F — Sign in (online, first time on a new machine)

1. Designer launches Helios. No keychain entry → login screen.
2. Enters email + password → `supabase.auth.signInWithPassword`.
3. Success → JS receives access + refresh tokens → stores refresh token in OS keychain → propagates session to Tauri side via Tauri command → Tauri command writes token to a daemon-readable file → notifies the daemon to pick it up.
4. Daemon reads the token, hashes the password (Argon2id) and stores the hash for offline-login fallback, opens the Realtime WebSocket, primes the local cache by listing the vault's files.

---

## Phasing

### Phase 1 — Vault MVP

Backend:

- Supabase project provisioned; migrations and RLS in `infra/pdm-supabase/`.
- `parse-refs` edge function with WASM `pdm-sw-parser` (basic CFB extraction, best-effort).
- Bootstrap-admin script.

Crates:

- `pdm-core` — domain types.
- `pdm-client` — Supabase wrapper + sync state machine.
- `pdm-sw-parser` — initial CFB parser; ships with known-version support, logs failures gracefully.

Apps:

- `apps/pdm-sync-daemon` — IPC server, local cache, offline queue, integrity check.
- `apps/pdm-shell-ext` — overlay icons + context menu via IPC to daemon.
- `apps/desktop` — login screen, OS-keychain token storage, offline login, role-gated UI, full Vault module (browse, file detail, history viewer, search, who-has-what, admin-users, admin-vaults, settings).

Packaging:

- One Windows MSI bundles `helios.exe`, `pdm-sync-daemon.exe`, and `pdm-shell-ext.dll` with the registry entries for shell extension and the HKCU\Run entry for the daemon.
- One Mac DMG with just `Helios.app` (no daemon, no shell ext).
- Auto-update for both via the existing minisign + GitHub Releases pipeline.

End state: a designer can log in, open the Vault folder in Explorer, right-click → Check Out → edit in SolidWorks → right-click → Check In, and have the change live for everyone with full audit. References are extracted and "where used" works. Admins can force-unlock and invite users. Mac users browse the vault read-only.

### Phase 2 — SolidWorks add-in

- New Windows-only project `apps/pdm-sw-addin/` (C# / .NET COM add-in; separate build pipeline since the Rust toolchain doesn't apply).
- In-SolidWorks task pane mirroring the shell-ext context menu (Check Out, Check In, Cancel, History).
- Read-only enforcement: SolidWorks save events are intercepted; saves to non-checked-out files are rejected with an explanatory dialog.
- Reference rewriting on rename / move within SolidWorks: the add-in updates `pdm.refs` and stages the parent assembly for re-check-in if the rename affects external paths.
- BOM extraction: on check-in, the add-in walks the assembly tree using the SolidWorks API and stores the BOM as JSON alongside the version (new column `pdm.versions.bom_json` or sidecar table).
- eDrawings preview generation: on check-in, the add-in generates a `.eprt` / `.easm` thumbnail and uploads it as a sibling object in Storage; the history viewer renders it.

### Phase 3 — Suite expansion & polish

- SSO via Supabase Auth providers (Google Workspace, school SAML).
- Webhooks / notifications: Slack or Discord on long-held locks, on releases, on configurable events.
- Activity feed in Helios.
- Multi-vault (e.g., one vault per car year), with vault switcher in the UI.
- Storage tiering: move archives older than N years to Storage's cold tier.
- Custom data cards / metadata schema editor (only if real demand emerges from Phase 1+2 use).
- Mac CAD ancillary file ops (CSVs, PDFs, docs in the vault — no SolidWorks).
- Possible new Helios suite modules (timing, strategy, telemetry-live) reusing the same identity layer.

---

## Risks & mitigations

**R1 — Windows shell extension fragility.** Shell extensions load into `explorer.exe`; a crash takes Explorer down. *Mitigation:* the DLL is intentionally inert (no I/O, no parsing). Every operation is a tight IPC call to the daemon with a 1-second timeout; every callable surface is wrapped in `catch_unwind`. Aggressive in-process caching of overlay state (invalidated by push from daemon) avoids per-icon IPC stampedes.

**R2 — Reference parsing without the SolidWorks SDK.** `.sldasm`/`.sldprt` are CFB containers with format details that vary by SW version and are not officially documented. *Mitigation:* `pdm-sw-parser` aims for best-effort extraction; failures are logged to `pdm.audit_log` (action `parse_refs_failed`) but do not block check-in. Any references not extracted in Phase 1 will be filled in by the SolidWorks add-in in Phase 2.

**R3 — Concurrent edit-without-checkout in Phase 1.** Without the SW add-in, nothing prevents a designer from opening a file in SolidWorks without checking out and editing. They simply can't *check in* without the lock. *Mitigation A:* the shell extension flips the OS read-only bit on every non-checked-out vault file. SolidWorks honors NTFS read-only — it prompts "Save As" instead. *Mitigation B:* prominent UI banner in Helios when a vault file is opened that the user doesn't have checked out. *Phase 2:* the SW add-in eliminates this entirely.

**R4 — Orphaned locks.** A designer checks out, laptop dies, vacation. *Mitigation:* explicit force-unlock by admin (no auto-expiry — auto-expiry on a binary CAD file is dangerous because the lock might still represent in-progress work). The "Who has what" view shows lock age; >24h gets a yellow flag, >7d red. Admin force-unlocks require a reason that's stored in the audit log.

**R5 — Supabase egress at scale.** SolidWorks assemblies can be tens to hundreds of MB. Frequent "Get Latest" on a deep tree could blow through the 250 GB Pro tier egress allowance. *Mitigation:* the daemon caches everything locally and only re-downloads when sha256 changes. With ~8 GB working set and ~10 designers, monthly egress is realistically <50 GB; metered overage is $0.09/GB if exceeded.

**R6 — Vault-as-source-of-truth migration.** First-time onboarding of an existing CAD project is the riskiest single moment. *Mitigation:* a one-shot import wizard (`apps/desktop/src/modules/vault/admin/Import.tsx`) walks an existing folder tree on the admin's machine, hashes everything, uploads, parses references, and produces a report of unresolved references. Run on a single Windows machine in one sitting before anyone else uses the system.

**R7 — Daemon / Helios startup ordering and authentication handoff.** The daemon needs the session token, which lives in the keychain accessed by Helios. *Mitigation:* the daemon reads the keychain on startup; if no token, idles and shows "sign in to Helios" overlay state. When Helios logs in (initial or refreshed), it writes the token to a file readable only by the daemon's user, then notifies via named pipe. The daemon never asks for credentials directly.

**R8 — Vendor coupling to Supabase.** Real but bounded. *Mitigation:* Supabase is open source — Postgres + GoTrue + PostgREST + Realtime + Storage all self-hostable on a single VM. The schema, RLS, and edge function are portable artifacts in `infra/pdm-supabase/`. We don't write Supabase-proprietary SQL.

**R9 — Helios major-version bump.** Adding required login is a breaking change for existing Helios users. *Mitigation:* call it Helios 3.0 in release notes; existing users sign up with their email on first launch after upgrade. Logs functionality is unchanged. Provide a migration note in `v2_changes/` (or its v3 successor).

---

## Open questions

1. **Where does the local Vault folder live by default on Windows?** Two choices: `%LOCALAPPDATA%\Helios\Vault\` (out of the way, but designers don't normally browse there) or a top-level location like `C:\Helios\Vault\` (more visible but pollutes the C: root). Real SolidWorks PDM uses the latter. **Default proposal:** `C:\Helios\Vault\` to mirror PDM convention; configurable in Settings during install.

2. **Working-copy isolation between users on shared machines.** If two designers share a Windows login (rare but possible at the team shop), they share the same local vault. The lock model still works (Supabase is the source of truth), but local edits could be ambiguous about authorship. **Proposal:** punt — document that each designer should have their own Windows login. Revisit if it bites.

3. **Versioning gap during edge-function failures.** If `parse-refs` fails, the version still exists; refs are missing. Should the audit log surface a "click to retry" UX, or should we silently retry on a schedule? **Proposal:** silent retry every 6 hours via a Postgres cron extension; admin UI shows a count of "pending parse" versions for visibility.

4. **History size growth.** Every check-in is an immutable version. After a year of active use, we may have 10k+ versions. Storage cost is fine (content-addressed dedup helps). UI: history list pagination should chunk to 50 versions at a time. **Proposal:** explicit pagination in Phase 1; Storage tiering is a Phase 3 concern.

5. **Identity carry-over for the existing log-mgmt module.** Do log files become user-attributed once auth lands? **Proposal:** no — the Logs module is unchanged in Phase 1 except for being gated behind login. Per-user log libraries / sharing is a separate future spec.
