# Changelog

All notable, user-facing changes to Helios are recorded here, newest first.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [semver](https://semver.org/).

<!--
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ AGENTS & CONTRIBUTORS — READ THIS BEFORE YOU FINISH A CHANGE.             │
  │                                                                           │
  │ Every user-facing change MUST get a bullet under [Unreleased] below, in   │
  │ the right group (Added / Changed / Deprecated / Removed / Fixed /         │
  │ Security). THIS FILE IS THE SINGLE SOURCE FOR RELEASE NOTES:              │
  │                                                                           │
  │   CHANGELOG.md  →  GitHub release body  →  team Slack channel             │
  │                                                                           │
  │ At release time `node scripts/bump-version.mjs <version>` promotes        │
  │ [Unreleased] to a dated version section; the Release workflow             │
  │ (.github/workflows/release.yml) drops that section into the GitHub        │
  │ release body and posts it to Slack. `scripts/check-versions.mjs` FAILS    │
  │ the release if the tagged version has no section here — a missing         │
  │ changelog blocks the release. So: if you don't add your entry here, your  │
  │ change does not propagate. (Older per-change dev-notes live in            │
  │ v2_changes/ and in past GitHub releases.)                                 │
  └─────────────────────────────────────────────────────────────────────────┘
-->

## [Unreleased]

This is a focused **Vault audit pass**: a deep bug + feature sweep of the Vault
module (SolidWorks PDM parity) followed by TDD'd fixes. Highlights are several
data-loss / data-integrity fixes in local sync and the recycle bin.

### Fixed

- Vault: **a checked-out file you delete locally and then "undo check-out" is no
  longer soft-deleted for the whole team.** Deletion propagation now re-checks
  that you still hold the lock at the moment of deletion, not just at the start of
  the sync pass.
- Vault: **a file you intentionally deleted no longer silently comes back.** When
  a copy reappears on disk (SOLIDWORKS rewriting it, antivirus restore, a re-copy),
  auto-add is suppressed for a cool-off window instead of re-vaulting it and undoing
  the deletion.
- Vault: **the SOLIDWORKS bridge "get latest" no longer overwrites a writable local
  copy** that may hold unsaved edits — it now skips the same way the drop-import and
  auto-sync paths do.
- Vault: deleting a folder you're currently inside now navigates to the nearest
  still-existing parent folder instead of leaving an empty file list; the breadcrumb
  no longer shows a dead path.
- Vault: a partial multi-file delete now un-checks only the files that were actually
  deleted, keeping the failures selected so you can retry.
- Vault: right-clicking a folder always shows the folder actions (New folder, Delete
  folder) even when other files/folders are selected.
- Vault: bulk check-out and bulk delete now stop immediately when you change the
  selection, switch vaults, or close the panel; an interrupted bulk delete reports
  how many files were removed.
- Vault: **Where Used** now lists only assemblies whose current version actually
  references the part — assemblies that dropped the part in a later check-in no longer
  appear, so archive/rename decisions are safe.
- Vault: a file's property data card now refreshes when another member's check-in
  changes a property value (not only when the number of properties changes).
- Vault: **Who Has What** now shows the holder's name for checkouts held by members
  of other vaults, instead of a raw id.
- Vault: an admin can no longer edit the owner account's profile from the Users &
  roles screen (the owner row is now protected, matching the role/revoke controls).
- Vault: custom properties (Material, Mass, Description, Part Number, …) are now
  extracted from very large assemblies (> 24 MB) instead of occasionally coming back
  empty when SOLIDWORKS stored the property block in the middle of the file.

## [4.4.6] - 2026-06-18

This release is a broad **pre-release polish pass**: a full-repo bug audit followed
by fixes across the Vault, PM, CFD, Games, the SOLIDWORKS add-in, and the Supabase
backend. Highlights are the vault data-loss and PM project-loss fixes.

### Added

- PM: **Creating a new project (season) now works end-to-end.** It saves through the
  secure server path and opens immediately, so the project and any tasks you add
  persist instead of vanishing on the next refresh. Creating a season is admin-only
  and now asks for the car year and a unique car code (e.g. `SDM28`); duplicate codes
  and permission errors are explained instead of failing silently.

### Changed

- PM: co-owner and task-link changes made in other sessions now appear live instead
  of waiting for the next full refresh.
- Vault: the Users & roles screen distinguishes an inherited global role from a
  per-vault override and disables Revoke on inherited rows.
- Vault: the SOLIDWORKS bridge sync backs off after repeated failures and refreshes
  an expired session instead of repeatedly re-pulling the catalog with a dead token.
- CFD: area-under-curve objectives now show the rpm-integrated unit (e.g. `kW·rpm`).
- Vault: "Set revision" returns a clear message when the revision number is already
  used on a file, instead of a raw database error.

### Fixed

- Vault: **auto-sync could silently soft-delete a checked-out file for the whole
  team** when its local copy was momentarily unreadable (e.g. open/locked by
  SOLIDWORKS). A deletion is now propagated only after confirming the file is
  actually gone from disk.
- PM: **a write that failed after you switched projects could overwrite the project
  you switched to.** Optimistic rollbacks are now scoped to the originating project.
- CFD: **importing a CSV with `NaN`/`Inf` corrupted the time axis and poisoned
  channel min/max/sum.** Non-finite times are now rejected and non-finite data cells
  load as null.
- CFD: **engine sweeps and optimizations aborted entirely** when the solver hit an
  unrecoverable state in a single RPM or trial; the failure is now isolated and
  reported as a divergence while the rest of the run continues.
- CFD: charts and readouts that mix channels from different sample-rate groups no
  longer pair data with the wrong time axis (which could show incorrect values).
- PM: co-owners added while creating a task are now saved (previously only the
  primary owner persisted); deleting a subteam no longer leaves an orphaned subsystem
  on re-homed tasks; a background refresh that collided with an in-flight save no
  longer drops the update; task links no longer record the wrong author.
- PM: a task can no longer end up with two primary owners.
- Vault: drag-and-drop import no longer silently overwrites a checked-out (writable)
  working copy; such files are skipped with a clear message.
- Vault: a new file version is no longer briefly hidden when a file update and
  check-in arrive together over realtime.
- Vault: lock-holder names now resolve for per-vault admins (previously
  "Locked by other") in both the Browse tree and Who-has-what; file delete in the
  right-click menu uses per-vault admin rights; Force unlock appears for admins of the
  active vault; a lock change in an unrelated vault no longer forces a full refresh.
- Vault: re-adding a file that was previously sent to the recycle bin now resurrects
  it instead of silently doing nothing; Where-Used no longer shows no results for a
  part whose name once belonged to a since-deleted file.
- Vault/SW: launch-on-login is no longer re-enabled on every startup after you disable
  it; the add-in auto-install prompt is no longer permanently suppressed after a
  declined or failed elevation; stale/truncated add-in and Explorer shell DLLs are now
  refreshed; icon-overlay registration no longer reports false success; a just-
  completed check-out/check-in from the add-in is no longer reverted by a concurrent
  vault refresh.
- CFD: dyno CSV import no longer silently drops rows using European decimal commas
  (skipped rows are counted and a warning shown); the master-report convergence chart
  is no longer drawn out of trial order; line charts no longer drop duplicate-x
  samples non-deterministically; clipboard TSV exports now escape tabs/newlines; a job
  could get stuck showing "running" on a poisoned lock and now records its status.
- Games: the breakout ball no longer tunnels through bricks at high levels; tied
  subteams in the standings now share a rank/medal.
- Org: the role and subteam grant dropdowns no longer offer subteam-only granters
  options the server would reject; the role editor no longer shows a spurious
  "unsaved changes" state from a color-case mismatch.
- Account deletion no longer fails for users who had filed a report or created a task
  link or co-owner record.
- Data: reading an empty Arrow IPC stream returns a graceful error instead of
  crashing; legacy SOLIDWORKS assemblies with UTF-16LE reference paths are now parsed;
  malformed mass-property vectors no longer render nonsense on the data card.
- Misc: lap-time/clock displays no longer show garbage for negative values; a rare
  cursor / view-state / lap-selection update is no longer skipped or double-delivered;
  the XY-plot filter and formula caches no longer grow unbounded.

### Security

- RBAC: fixed a privilege over-grant where signups whose subteam didn't match a known
  team received org-wide engineer/lead capabilities; they are now confined to an
  "Unknown" subteam, and subteam-scoped grants can no longer be saved without a
  subteam.
- Vault: checking in or cancelling a checkout is no longer allowed after a user's
  editor role is revoked while they hold the lock; a user can no longer move their own
  lock onto a file in a vault they cannot edit.
- Vault/SW: add-in registry installs now use a per-launch private temp directory,
  hardening the elevated import against local tampering; "reveal in Explorer" and the
  read-only file toggle reject malformed/symlinked paths.
- Database: enabled row-level security (default-deny) and revoked client grants on
  internal `pm` backup snapshot tables (`tasks_project_move_backup`,
  `deleted_tasks_backup`, `tasks_status_backup`) that were exposed in an API-visible
  schema without RLS, resolving the two Supabase Security Advisor errors.

## [4.4.5] - 2026-06-18

### Fixed

- PM: fixed a crash that could make the Project Management module fail to load
  ("Spread syntax requires ...iterable") right after updating, when a workspace
  cached by an older version was missing a newer field. Hydration is now
  crash-proof and stale caches refresh automatically.
- Games: the **subteam standings** no longer let one game decide everything. Raw
  scores were summed across games, so 2048 (scores in the thousands) buried Snake,
  Breakout, and Flappy (scores in the tens). Subteams are now scored
  **Grand Prix style** -- ranked within each game for placement points
  (10/8/6/5/...) that sum across games, so every game counts equally.

## [4.4.3] - 2026-06-18

### Added

- PM: tasks can now have **multiple owners**. The Owner field still sets the
  primary owner; a new "Co-owners" control on the task detail panel adds other
  members who can also edit the task. (Requested in-app by Alex Rumer.)
- PM: attach **hyperlinks** to a task. A new "Links" section on the task detail
  panel lets you add labeled URLs (docs, drawings, specs) that open in your
  browser. (Requested in-app by Jaxson Whitelaw.)

## [4.4.2] - 2026-06-17

### Added
- **Admin section (new, owner/admin only).** A top-level **Admin** area that
  manages access across both Vault and PM from one place:
  - **People & Roles** — assign each person a role; edit their name and subteam.
    Roles are a clean rank-per-subteam model — Engineer / Lead / VP within a
    subteam, plus org-wide **Executive** and specific officer titles (President,
    COO, CFO, Chief Engineer). All grants are guarded server-side (you can only
    grant what you hold; the Owner can't be removed).
  - **Org Structure** — map which subteams build which car and tag each car
    **IC** or **EV**; create and remove subteams (a subteam in two cars is
    "shared").
  - **Role Editor** — create and edit roles and exactly which capabilities each
    one grants — no more hard-coded permissions.
- **Google Calendar on the PM calendar.** The team Google Calendar is pulled in
  automatically (refreshed hourly), with recurring meetings expanded to every
  date and cancellations/changes reflected. Toggle the layer on/off (your choice
  is remembered) and click any event for full details.
- **Dashboard photos.** A Photos widget lets a subteam (or the all-team)
  dashboard carry images — editable by that subteam's lead+ (or an executive),
  visible to everyone.
- **Dashboard "Date histogram" widget.** A new customizable dashboard widget
  charts your tasks bucketed across time by their **start** or **due** date —
  from the earliest to the latest — so you can see when work is scheduled to
  ramp. Buckets auto-widen (daily → weekly → monthly) as the span grows, or you
  can pin a fixed size, and filter to all / open / due-window tasks.

### Changed
- **User & role management moved out of the Vault** into the new **Admin**
  section, since roles now govern both Vault and PM.

### Fixed
- **Shared subsystems can now be picked on tasks.** A subsystem shared into a
  subteam (in the Subsystem Editor) was missing from the Subsystem dropdown when
  creating or editing a task under that subteam, so only the owning subteam could
  use it — defeating the point of sharing. The create dialog and task detail
  panel now list shared subsystems alongside owned ones.

## [4.4.1] - 2026-06-17

### Added
- Admins can leave a **resolution note** on a bug/feature report. The note shows
  in the reports viewer and is visible to the person who filed the report.

### Fixed
- **Project tasks: edits that silently reverted now save — or tell you why.**
  Changing a task's priority, owner, status, or other fields could look like it
  worked and then revert after switching tabs or restarting, whenever you didn't
  have permission to edit that task. PM now rolls the change back and shows the
  real reason (e.g. "engineers can only edit tasks they own or created") instead
  of silently dropping it. This covers all of PM — tasks, milestones, vendors,
  calendar events, subteams, subsystems, and dependencies — not just tasks.
- **You can now edit tasks you created.** New tasks record their creator, so
  whoever makes a task can edit it even if it isn't assigned to them. (Tasks
  created before this update keep their existing owner/lead/admin edit rules.)
- Task detail fields are now **read-only with an explanation** when you can't
  edit that task, instead of showing editable controls whose changes wouldn't
  save.

## [4.4.0] - 2026-06-16

### Added
- In-app **Bug / Feature report** tool — a "Report a bug" button in the sidebar
  that captures a diagnostics snapshot (recent breadcrumbs + last error) and an
  optional screenshot, plus an admin-only **reports viewer** with status triage
  (new → triaged → fixed).
- Reports viewer is **color-coded** by kind (bug / feature), severity, and
  status, and shows the reporter's **name, subteam, and email**.
- Admins can **delete reports** (and their screenshot attachments) from the
  viewer.

### Changed
- **App-wide visual refresh.** The intended typography (Inter for UI, JetBrains
  Mono for numbers) is now actually bundled and renders identically on every
  machine instead of falling back to OS fonts. The primary module rail and the
  per-module sidebars (Vault/CFD/PM) now share one icon-row design language with
  a consistent grey rail and gold-tint active state. Added consistent focus
  rings, panel elevation, modal entrance motion (all reduce-motion aware), global
  scrollbars, branded empty states, and a refined loading screen.
- Renamed the Vault "Who has what" screen to **"Checkouts"**.
- Report screenshots are now attached by **uploading an image file** rather than
  the in-app window capture.

### Removed
- The native window-capture command (`capture_app_screenshot`) and its `xcap`
  dependency, which never reliably captured the report screenshot.

### Fixed
- Vault PDM cutover hardening: bulk check-in/out/cancel now keep the read-only
  bit correct, file create+lock no longer reports false success, a stale move
  ledger entry can no longer soft-delete a live file, and per-vault role/admin
  affordances are scoped correctly.
