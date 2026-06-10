# 57 — PM: create subsystems where you need them

**Date:** 2026-06-09

Subsystems felt hardcoded: the editor was buried on the dashboard, DB writes
were admin-only, and delete silently never worked.

- **Quick-create in every subsystem picker**: "+ New subsystem…" in the
  create-task dialog and the task detail sheet opens a small inline dialog
  (name + color, subteam fixed to the picker's context), creates through the
  same optimistic+persisted store path as the editor, and selects the new
  subsystem immediately. The create-task picker is no longer disabled when a
  subteam has zero subsystems — that was the "stuck" state.
- **DB policy**: team members (any pm.team_memberships row) can now INSERT
  subsystems; update/delete stay admin-only. Applied to hosted + mirrored
  (`20260610010000_pm_members_create_subsystems.sql`).
- **Bugfix**: SubsystemEditor's delete used window.confirm — a NO-OP in the
  Tauri webview, so removal silently never ran. Replaced with a two-step
  inline confirm that states the impact ("Unassign N tasks & remove?").

178 desktop test files + typecheck green.
