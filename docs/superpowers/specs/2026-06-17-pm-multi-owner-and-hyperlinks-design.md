# PM: Multiple Task Owners + Hyperlinks — Design

Date: 2026-06-17
Source: two in-app feature reports in `support.reports` (status `new`):
- "Multiple task owners" — Alex Rumer (Data Acquisition)
- "Hyperlinks" — Jaxson Whitelaw (Engine)

Both target the **PM** module. Shipped together in v4.4.3.

## Feature 1 — Multiple task owners

Today `pm.tasks.owner_id` is a single nullable uuid. We add co-owners while keeping
`owner_id` as the denormalized **primary owner** mirror, so every existing read,
filter, color-by-owner, RLS check, and the dashboard/report code keeps working
unchanged. This mirrors the proven `pm.task_subteams` multi-membership pattern.

### Schema (`20260617012000_pm_task_owners.sql`)
- `pm.task_owners(task_id, owner_id, is_primary, created_at, created_by, pk(task_id, owner_id))`.
- Partial unique index: one primary per task. Index on `owner_id`.
- Backfill from `tasks.owner_id` (is_primary=true) where not null.
- RLS: read = project member of the task (or `can_read_pm`); write = `can_edit_task`.
- **Bidirectional sync, recursion-guarded with `pg_trigger_depth() = 0`:**
  - Trigger A on `pm.tasks` AFTER INSERT OR UPDATE OF owner_id: makes `NEW.owner_id`
    the primary row in `task_owners` (or clears primary when null). Handles every
    existing scalar write path (detail Select, table inline, bulk edit, task create).
  - Trigger B on `pm.task_owners` AFTER INSERT/UPDATE/DELETE: sets `tasks.owner_id`
    to the current primary owner (or null). Handles co-owner + RPC writes.
  - Each guards on `pg_trigger_depth() = 0`, so a write settles in one hop with no
    infinite recursion.
- RPC `set_task_primary_owner(p_task_id, p_owner_id)` (auth via `can_edit_task`):
  ensures membership then flips `is_primary`.
- **Update `pm.can_edit_task`**: the engineer branch now also returns true when the
  user is *any* owner: `exists (select 1 from pm.task_owners o where o.task_id = t.id
  and o.owner_id = uid)`. So a co-owner can edit the task — the point of the feature.

### Frontend
- `TaskRow.owners: User[]` (primary first), populated in `data.ts` from a
  `task_owners(owner_id,is_primary)` embed resolved against the directory.
- `owner` / `owner_id` stay = the primary owner (unchanged).
- Store actions `addTaskOwner / removeTaskOwner / setPrimaryOwner` mirror the subteam
  membership actions (optimistic + rollback). `embedTaskPatch` keeps `owners` aligned
  when `owner_id` changes via a scalar patch; `addTask` seeds `owners` from the owner.
- UI: the existing "Owner" Select stays (primary owner). A new **co-owner chips**
  control (`TaskOwnerChips`) below it adds/removes additional owners and can promote
  one to primary — analogous to `TaskSubteamChips`. Create dialog / table / bulk are
  unchanged (they set the primary). Co-owners are managed from the detail sheet.

## Feature 2 — Hyperlinks

Attach labeled URLs to a task. Scoped to **tasks** for v1 (the only PM entity with a
detail panel). Projects/meetings/reports have no detail UI to host links yet, so
those are explicitly out of scope (noted as future). Mirrors `pm.task_comments`.

### Schema (`20260617013000_pm_task_links.sql`)
- `pm.task_links(id, task_id, url text, label text null, created_at, created_by)`.
- `check (url ~* '^https?://')`. Index on `task_id`.
- RLS: read = project member of the task (or `can_read_pm`); write = `can_edit_task`.

### Frontend
- `taskLink` zod type in pm-ui. `ProjectData.links` + flat `links` in the store,
  loaded/filtered exactly like `comments`.
- Store `addLink / deleteLink` (optimistic). Mutations `insertTaskLink / removeTaskLink`.
- UI: a "Links" section in `TaskDetailSheet` (mirrors Comments): URL + optional label
  input, list of links each opening in the system browser and removable by editors.
- Opening external URLs: new std-only Rust command `open_external_url` (http/https
  only) mirroring `reveal_in_explorer` — no new Tauri plugin, to keep release risk low.

## Out of scope / YAGNI
- Project/meeting/report-level links (no detail UI host yet).
- Per-owner notifications, owner workload rollups, link previews/thumbnails.

## Testing
- Unit: new mutation writers (insert/remove owner + link, set-primary RPC) against the
  existing supabase recorder; store actions (add/remove/promote owner, add/delete link)
  optimistic + rollback; `selectCanEditTask` co-owner branch; snapshot round-trip
  includes `links`.
- Typecheck + lint + full PM test suite green before release.

## Release
v4.4.3: bump version (package + tauri + Cargo.lock sync), commit, push, run the
release workflow (full ~70-min sequential build, draft→publish at the end), confirm
the final Slack notification fires.
