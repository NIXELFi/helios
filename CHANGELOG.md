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

## [5.0.1] - 2026-07-01

### Fixed

- Marketplace: installed plugins now execute their code. They were mounted in an
  iframe via `srcDoc`, and an `about:srcdoc` document inherits the host window's
  CSP (`script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-inline'`), which
  intersected with and blocked every plugin's self-contained inline bundle — the
  plugin rendered its static HTML but ran no JavaScript (blank frame). Plugins now
  load from their own `plugin://<id>` origin (`src=` instead of `srcDoc`), so the
  frame applies the plugin-host's response-header CSP (which allows `'unsafe-inline'`)
  instead of inheriting the host's. `frame-src` widened to allow `plugin:`.

## [5.0.0] - 2026-06-30

### Added

- **Marketplace (v5 plugin platform) — early beta**: a new Marketplace module — the
  first cut of where Helios is heading: first-party "Built-in" apps, bundled
  sandboxed plugins, and a live catalog of installable marketplace plugins, side by
  side. **This is an early beta — try it out and expect rough edges.** Add-ons run in
  a locked-down sandbox (opaque-origin iframe + strict CSP) that cannot reach the DOM,
  the database, the network, or the filesystem on their own; they declare capabilities
  in a manifest (default-deny) and reach the host only through a permission-checked
  broker (`@helios/plugin-sdk`) — user-picked file open/save and private per-plugin
  storage, with a curated high-trust MATLAB engine bridge designed for later.
  Installing fetches the content-addressed bundle, verifies its sha256 **and** an
  Ed25519 signature before unpacking, and shows an explicit consent screen (with an
  unmissable warning before anything high-trust). **CFD** now appears as a first-party
  Built-in app; the **Lap Sim** ships as a bundled sandboxed plugin (extracted from
  CFD and versioned independently of Helios); and **COAST** — the chassis-optimization
  + 3D torsional-FEA tool — is the first plugin published through the real
  sign-and-review pipeline and installable straight from the catalog. Includes an
  Agent Authoring Kit for AI-assisted plugin authors and a `helios-plugin check`
  compliance validator. In-app publishing isn't built yet — the "Upload plugin" button
  is a disabled placeholder, and new plugins are published server-side for now.

### Changed

- **CFD has moved off the main sidebar into the Marketplace** (as a first-party
  Built-in app) — open it from the Marketplace tab. It runs exactly as before.

## [4.5.6] - 2026-06-30

### Added

- **Custom subteam icons**: a subteam's icon can now be set explicitly and persists
  for everyone, instead of only being auto-derived from its name/code. Leads,
  Executives, and Owners click a subteam's icon in the PM sidebar to pick from the
  built-in glyph bank (now expanded with tires, battery/accumulator, electrical,
  cooling, fuel, turbo/intake, exhaust, and manufacturing marks), or reset it back
  to automatic. The ability isn't tied to which subteam you belong to — any
  lead/exec/owner can set any subteam's icon. Picks inherit the subteam color.

## [4.5.5] - 2026-06-29

### Added

- **PM — "Primary only" view toggle**: in any subteam-scoped view (dashboard,
  table, board, calendar, gantt) a new "Primary only" toggle hides tasks where
  the subteam is merely a secondary contributor, leaving just the tasks it
  primarily owns. Off by default and remembered per user, so it never changes
  what teammates see. (Tasks dropped from the owned list still surface as a
  dependency bridge when they connect to the team's work.)
- **Vault — check in from the Checkouts screen**: each of your own checkouts now
  has a "Check in" action on the Checkouts ("Who has what") screen, plus a
  "Check in all mine" button that checks in every file you have checked out in
  the active vault at once — no more hunting each file down folder-by-folder in
  the Browse tree. Freshly-uploaded drafts are published as-is; files you edited
  locally land a new version. (Acts on the active vault, where your local working
  copies live.)

### Changed

- **PM Slack notifications restructured for readability**: each notice now leads
  with who did what and lists field changes one per line (friendly status labels,
  `old → new`), and includes the task **owner and its subteam lead** as recipients
  so leads are notified of changes regardless of who owns the task. (Owner and lead
  are sent to the Slack workflow as user emails — via a new `lead` variable — so the
  workflow can either ping them or show their name.)

## [4.5.4] - 2026-06-24

### Added

- **CFD Lap Sim — vehicle-dynamics (VD) parameter sweeps**: sweep total mass,
  roll-stiffness distribution (RSD), and tire-µ load-sensitivity ("%dropoff")
  across the existing lap sim, with a "lap time vs parameter" plot (baseline
  marked) and a sweep-summary CSV export, reusing the A/B compare workflow. CG
  height is also surfaced as an editor input; CG-height sweeps run on
  lumped-model vehicles, while on roll-config cars they're gated pending the
  quasi-steady-state model work (the current per-axle model keys lateral load
  transfer on roll-arm height, not raw CG).
- **PM — per-project subteam visibility**: a new "Hidden subteams" menu below
  the project subteam sidebar. Project owners/executives can hide subteams that
  aren't relevant to a project for everyone; any member can unhide them for
  themselves or hide additional subteams in their own view. Display-only —
  hidden subteams' tasks stay assigned and remain filterable everywhere else.
- **CFD — sortable Studies list**: sort saved studies by name, kind, status, or
  start date (ascending/descending) via clickable column headers; your choice is
  remembered.

### Fixed

- **Report a bug/feature dialog**: typing in the Details field no longer
  randomly jumps the cursor back to the Title field (it was triggered whenever a
  teammate's presence update re-rendered the app while the dialog was open).

## [4.5.3] - 2026-06-23

### Changed

- **PM task editing**: any **editor (engineer or above)** of a project or subteam
  can now edit every task in their scope — including reassigning its owner and
  changing any other property — not just tasks they personally own or created.
  Admins and leads were already unrestricted; viewers remain read-only.

## [4.5.2] - 2026-06-22

### Changed

- Org admin panel now surfaces the full set of grantable permissions for each
  role and subteam, clearly distinguishing the ones you're allowed to grant from
  the ones you aren't (rather than silently rejecting on save).

### Fixed

- Sign-up: the **subteam picker loads again**. The `list_signup_subteams` lookup
  was addressed to the wrong Postgres schema (`pdm` instead of `public`), so the
  picker errored out with "Could not find the function" and dead-ended sign-up.
- Vault: the sync ledger no longer fails intermittently with "No such file or
  directory" when checking files in. The app-data folder it writes to may not
  exist yet, and the write did not create it; the directory is now ensured first.
  (Harmless before this -- it only meant local-deletion detection lagged a pass --
  but it logged a console warning on check-in.)
- Vault: a corrupted folder parent chain no longer hangs or crashes the whole
  Vault -- folder-path lookups are now cycle-guarded.
- Vault: the vehicle mass KPI no longer double-counts assembly rollup mass
  against its own parts (it was inflated 2x or more).
- CFD: result, lap, and sweep pages no longer white-screen on empty or
  degenerate data; a single-RPM study no longer gets permanently stuck after a
  solver error (which previously blocked all further single-RPM runs that session).
- PM: the bulk "Due date" field no longer clears the due date on every selected
  task when left empty and blurred; task title/description edits no longer write
  to the database on every keystroke (which also destroyed the undo stack); and
  creating a task with dependencies or extra subteams no longer races and
  silently drops them.
- Games: retrying a score submission on a flaky network can no longer create
  duplicate leaderboard rows, and tied scores now share a rank.
- CSV import: semicolon/tab-delimited MoTeC and Link exports, and
  thousands-separated dyno values, now import correctly.
- Many additional correctness, state-reset, and stale-data fixes across CFD,
  Vault, PM, Org, and shared chart widgets. See
  docs/audits/2026-06-22-v4-bug-vault.md.

### Security

- New self-signup accounts are now provisioned as read-only viewers instead of
  global editors, so a newly created account cannot read or modify vault contents
  until an admin promotes it.
- Sign-up is now restricted to approved email domains, enforced server-side
  (seeded with asu.edu and configurable in the database -- not hardcoded in the
  app), so only organization accounts can register.
- Per-vault (subteam-scoped) admins can no longer act as global admins: deleting,
  updating, or listing users org-wide, viewing other vaults' rosters, or granting
  and revoking global roles now requires a true global admin.
- CFD capture loading rejects directory-traversal in job identifiers, confining
  reads to the captures folder.
- CSV exports are now guarded against spreadsheet formula injection.

## [4.5.1] - 2026-06-21

A small follow-up addressing three member feature requests.

### Added

- CFD: **overlay multiple sweep runs** on the result graphs — pick several past
  sweeps from the Overlay strip to compare them on the same charts (e.g. to find
  the best collector length), each with its own color and legend (up to 5).
- CFD: **zoom into result graphs** — click-drag on a chart to zoom the RPM axis;
  a "Reset zoom" button restores the full range.

### Fixed

- Sign-up: the **subteam dropdown now includes every subteam** an admin has added
  in either admin area (e.g. the EV subteams High Voltage / Low Voltage / Battery),
  instead of only the original identity list.

## [4.5.0] - 2026-06-20

This is a focused **Vault audit pass**: a deep bug + feature sweep of the Vault
module (SolidWorks PDM parity) followed by TDD'd fixes. Highlights are several
data-loss / data-integrity fixes in local sync and the recycle bin, plus a fix
for new members landing without vault access.

> Note: the backend (Supabase) migrations below have been applied to the hosted
> database and verified.

### Added

- Vault: **mass / weight-budget dashboard** on the Insights screen — total vehicle
  mass, heaviest parts, mass by subsystem, parts missing mass data, and a delta vs an
  admin-set target mass, all from the Mass already parsed off each part's data card.
- Vault: **impact warning before checking out or deleting a referenced part** — if
  other assemblies currently use the part, you're shown which ones first.
- Vault: **bill of materials (BOM)** for assemblies — open it from a `.sldasm` file's
  details for an indented or flattened parts list with quantity roll-up, total mass,
  and CSV export, built from the stored reference graph.
- Vault: **search by custom property** — type a value like `7075` to find parts by
  their data-card properties, or use `prop:Material=7075` / `prop:Status="In Review"`
  filters, in addition to filename search.
- Vault: **watch files + a notification feed** — star a file to get a bell-icon feed of
  check-ins, check-outs, force-unlocks, deletes and restores on the parts you care
  about. (v1 is per-device; a shared server-side feed is a planned follow-up.)

### Security

- Vault: **closed a cross-vault audit-log leak** — a member of one vault could read
  another vault's activity (check-ins, force-unlocks, role changes) by reading the
  audit log directly. Reads are now limited to your own activity, with full access
  for global admins/owners.
- Vault: **only the owner can edit the owner account** is now enforced on the server
  (not just hidden in the UI), matching the existing owner-delete protection.
- Vault: restoring a file or folder from the recycle bin now requires you to
  **currently** hold edit rights — a member whose role was revoked after deleting can
  no longer restore.
- Vault: deleting a file that someone else has checked out now **records who broke the
  checkout** (force-unlock attribution + audit entry) instead of releasing it silently.

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
- Vault: restoring a single file whose folder was deleted now brings the folder back
  too, so the file is browsable again instead of being stranded in a deleted folder.
- Vault: **Where Used / Contains stay correct across delete and restore** — deleting a
  part now marks references to it unresolved, and restoring it re-links them, instead
  of waiting for the next check-in.
- Vault: restoring an old version now points its references at each child's current
  version rather than re-pinning stale ones.
- Vault: assembly references can now be recorded for imported (migrated) versions.
- Vault: Insights no longer count recycle-bin files in its totals, and the "orphans"
  metric now counts genuinely unreferenced parts (it previously missed top-level
  assemblies).
- Vault: **new members now get vault access automatically on sign-up** — every new
  account is granted the baseline Editor role instead of landing with no access at
  all (officers/leads are still promoted to Admin by an admin). Existing members who
  had slipped through without a role were backfilled.
- Vault: the bill of materials no longer merges two different unresolved parts that
  happen to share a filename into one row with a combined quantity.
- Vault: opening a bill of materials that fails to load now shows an error with a
  Retry instead of hanging on "Loading…"; deleting a file shows its where-used impact
  without a blank pause.
- Vault: restoring an old assembly version no longer shows parts that were deleted in
  the meantime as still-present, and restoring a part no longer re-links it under an
  assembly that is itself in the recycle bin.
- Vault: Insights/mass dashboard now resets cleanly when you switch vaults instead of
  briefly showing the previous vault's numbers.
- Internal: audit-log entries carrying an action from a newer server build no longer
  fail to load in older clients.

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
