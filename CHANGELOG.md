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
