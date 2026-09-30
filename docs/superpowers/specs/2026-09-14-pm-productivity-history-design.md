# PM task history export + Productivity view

Date: 2026-09-14. Requested by a team member who wants to map task completion and productivity over time.

## What already exists
- `pm.tasks` has created_at / updated_at / created_by / updated_by, start_date, due_date, estimate_days, actual_days. No completed_at.
- `pm.activity` logs created / updated / deleted / status_changed / completed / linked / unlinked / reviewed per project with actor_id, target_id, target_name, subteam_ids, payload (`{from,to}` on status changes), created_at. A trigger writes `completed` when a task's status becomes `done`. History exists since 2026-06-02.
- The desktop client only pulls the latest 250 activity rows for the feed. RLS: project members and PM readers can select activity.

## Decisions (defaults chosen, not asked)
1. **Completion time is derived, not stored.** `completed_at` = the LATEST `completed` activity row for the task (a task reopened and re-done counts once, at its last completion). No new column, no backfill.
2. **Person-level numbers are gated.** Subteam-level metrics are visible to anyone who can read PM. The per-person breakdown and the raw export (which includes actor ids) require `pm.manage_dashboard` in that subteam or project-wide (same gate as shared dashboard layouts). Student team; keep individual productivity behind the lead/VP gate.
3. **One server RPC, not a new client query path.** `pm.task_history(p_project_id uuid, p_from timestamptz, p_to timestamptz, p_subteam_id uuid default null)` returns flattened rows for the window. Security definer, `(select auth.uid())` pattern per the 5.7.1 perf work, explicit project-membership check, capability check for actor columns (actor nulled out when the caller lacks manage_dashboard in scope).
4. **Export = CSV via Tauri save dialog**, same plumbing as the Deadlines report (plugin-dialog + plugin-fs). Columns: event_time, action, task_id, task_title, subteam, status_from, status_to, actor (name, gated), task_created_at, task_due_date, task_status_now, estimate_days, actual_days.
5. **Productivity view = new PM view segment `productivity`** in `nav.ts` VIEW_SEGMENTS, rendered in PmModule, sibling of `activity`. Reachable from the sidebar like the other views. Scoped to the current subteam when inside /team/[slug].
6. **Charts are inline SVG**, matching the existing dashboard (no chart library added).

## Productivity view contents
Controls: date range presets (4 weeks, 12 weeks, season-to-date, custom), subteam picker (project scope only), Export CSV button.
Panels, computed client-side from the RPC rows by a pure `productivityMetrics.ts` (fully unit-tested):
- **Throughput**: tasks completed per ISO week, stacked by subteam (or by person when gated + toggled on).
- **Created vs completed burn-up**: cumulative created and cumulative completed lines over the window.
- **Cycle time**: median and p85 days from task created_at to last completion, per subteam, plus a small histogram.
- **On-time rate**: share of completed tasks whose last completion ≤ due_date (tasks with no due date excluded and the exclusion count shown).
- **Open work aging**: current open tasks bucketed by age (0-7, 8-14, 15-30, 30+ days).
- **Per-person table** (gated): completions, median cycle time, on-time %, currently open. Hidden entirely, with a one-line note, when the caller lacks the capability.

## Error handling
- RPC failure → view shows the standard PM error state with retry; export button disabled.
- Migration not yet applied ("function does not exist") → the view renders a "not available on this server yet" notice, same fail-soft pattern data.ts uses for project_hidden_subteams.
- Empty window → empty state per PM conventions.

## Testing
- SQL: none automated (repo has no pg test harness). The migration must be idempotent and reviewed by hand.
- `productivityMetrics.test.ts`: week bucketing across year boundary, last-completion rule for reopened tasks, cycle-time percentiles, on-time with missing due dates, aging buckets, person aggregation.
- `taskHistoryCsv.test.ts`: escaping commas/quotes/newlines, gated actor column omitted.
- Component smoke test for the view rendering with fixture rows and with the "not available" error.
- `pnpm typecheck` and `pnpm test` in apps/desktop green.
- CHANGELOG [Unreleased] entries under Added.
