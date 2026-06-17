# Org & Access + Dashboard Customization — Design Spec

- **Date:** 2026-06-17
- **Status:** Draft (for review)
- **Target release:** v4.4.2 (ships together with the shared-subsystem bug fix already on `feat/v4.4.2-org-access`)
- **Related:** bug fix `8595e90` (shared subsystems selectable); feature report "Improved Dashboard Customization" (`support.reports`)

---

## 1. Motivation

A v4.4.2 feature report ("dashboard photos editable only by leads/admins of that subteam" + "more statistics") exposed a deeper problem: **the org structure is hardcoded and fragmented.** Subteams are global, EV vs IC isn't modeled, and Vault and PM each have their own separate role system. We cannot gate a dashboard photo on "the lead of that subteam" because *no such concept exists in the data.*

This spec replaces hardcoded structure with **configured data** and unifies access control across Vault + PM, then builds the dashboard feature on top of it. Guiding principle (locked): **no hardcoded org structure — it is editable data with an admin tool.**

## 2. Current state (verified against live DB `dlmyixonuyckxkknolku`)

| Area | Today |
|------|-------|
| Projects | `SDM26`, `SDM27` (IC), `SDM27e` (EV) — `pm.projects` |
| Subteams | 11, **global** (`pm.subteams`, no project link): Aero Design, Aero Manufacturing, Brakes, Chassis, DAQ, Driver Interface, Drivetrain, Engine, Low Voltage, Suspension, Unknown. A parallel `pdm.subteams` drives the Vault signup picker. |
| Vault roles | `pdm.user_roles {owner, admin, editor, viewer}`, per-vault (`vault_id` NULL = global). Default-deny. Owner-only grants admin. Helpers `pdm.is_owner/is_admin/is_admin_in/can_edit_in`. UI: `vault/screens/AdminScreen.tsx`. |
| PM roles | `pm.team_memberships {admin, lead, engineer, viewer}`, per-project. RPC `pm.my_team_roles()`. UI: gated by `selectIsAdmin`/`selectCanEditTask`. |
| Dashboards | Per-user **localStorage only** (`pm/lib/dashboardSettings.ts`); no shared/server layer. |

## 3. Goals / non-goals

**Goals**
1. **Data-driven org structure:** map each subteam to a program/project (`SDM27` / `SDM27e` / shared), editable in-app.
2. **One unified role model** consumed by both Vault and PM: `owner → executive → lead/vp → engineer → viewer → none`, cumulative, **default-deny**, grant-down-only.
3. New **Executive** role = Owner-level capability, displayed as "executive" (collapses President/COO/CFO/Chief).
4. **Top-level "Org & Access" admin surface** in the main sidebar (moved out of the Vault tool, since it governs both products).
5. **Dashboard:** task-start **histogram** widget (client-only) + **shared photos** widget (server-backed, role-gated).

**Non-goals (this release)**
- Editable capability matrix / custom role creation (deferred "Phase C" — see §9). Phase A capabilities are fixed in code/SQL.
- Per-program differentiation of Executive capability (all execs are owner-equivalent for now).
- Migrating historical audit/role tables away; old tables stay intact during transition.

## 4. Role & capability model (Phase A — fixed capabilities)

**Roles (cumulative; each inherits all below within its scope):**

| Role | Scope | Inherits | Notes |
|------|-------|----------|-------|
| `owner` | org-wide | everything | bootstrap-managed (Nick). Single. |
| `executive` | org-wide | lead everywhere | = owner power, labeled exec. Chiefs/Pres/COO/CFO. |
| `lead` / `vp` | per subteam | engineer (that subteam) | "subteam admin": can grant engineer within their subteam. `vp == lead` in capability for now. |
| `engineer` | per subteam | viewer (that subteam) | can edit tasks/files in subteam. |
| `viewer` | per subteam | — | read-only. |
| _(none)_ | — | — | **default for new accounts**; no access. |

**Capability → minimum role (Phase A, fixed):**

| Capability | Requires |
|------------|----------|
| View tasks/files | `viewer` (in scope) |
| Edit tasks / check-in files (in subteam) | `engineer` (in subteam) |
| Manage subteam content (subsystems, dashboard photos) | `lead`/`vp` (subteam) |
| Grant **engineer/viewer** within a subteam | `lead`/`vp` (subteam) |
| Edit org structure (subteam↔project map), manage subteams | `executive` / `owner` |
| Grant **lead/vp/executive** | `executive` / `owner` (you can only grant **at or below your own scope**) |

## 5. Data model

### 5.1 New `org` schema (single source of truth)

```
org.role  enum: owner | executive | lead | vp | engineer | viewer
org.memberships (
  user_id     uuid    references auth.users,
  role        org.role,
  subteam_id  uuid    null  references <canonical subteams>,   -- NULL = org-wide (owner/executive)
  granted_by  uuid,
  granted_at  timestamptz default now(),
  unique (user_id, coalesce(subteam_id, '0000…'))   -- one role per (user, scope)
)
```
SECURITY DEFINER helpers (the capability surface both products call):
`org.is_owner(uid)`, `org.is_exec_or_above(uid)`, `org.role_in_subteam(uid, subteam_id)`,
`org.can_view/can_edit/can_manage(uid, subteam_id)`. Phase A encodes the §4 matrix inside these.

### 5.2 Subteam ↔ project mapping (kills the "global" hardcoding)

```
pm.project_subteams ( project_id uuid, subteam_id uuid, primary key (project_id, subteam_id) )
```
- "Shared" is emergent: a subteam linked to ≥2 projects.
- **Back-compat seed:** insert every (existing project × existing subteam) so current behavior is unchanged on day one; admins then prune EV-only/IC-only via the tool.
- Subteam *list* stays global; *applicability per car* comes from this join.
- **Reconcile `pm.subteams` vs `pdm.subteams`:** pick `pm.subteams` as canonical and have the Vault signup picker + `org.memberships.subteam_id` reference it (bridge view during transition). Detailed in the plan.

### 5.3 Dashboard photos

```
storage bucket: dashboard-photos (private)
pm.dashboard_photos ( id, project_id, subteam_id null, storage_path, caption, sort_order, created_by, created_at )
```
RLS: **select** = any authenticated member with view in scope; **insert/update/delete** = `org.can_manage(uid, subteam_id)` (lead+ of that subteam, or exec/owner). `subteam_id` NULL = the all-team/project dashboard (exec/owner-managed).

## 6. RLS cutover

Rewrite the gates that exist today to consult `org.*` helpers, keeping old helpers as thin shims so nothing breaks mid-migration:
- **Vault:** `pdm.is_admin_in/can_edit_in` → delegate to `org.*` (admin→exec/lead, editor→engineer mapping). Existing per-vault policies unchanged in shape.
- **PM:** `pm.my_team_roles()` + `selectCanEditTask` mirror → `org.*`. Task edit requires `engineer`+ in one of the task's subteams.
- The flip is the **single highest-risk step**; it ships behind verification (§8) and is reversible by repointing the shims.

## 7. Frontend

### 7.1 "Org & Access" sidebar section (shared, top-level)
Three panels, backed by `org.*` + `pm.project_subteams`:
1. **People & Roles** — every account, its role + scope; grant/revoke limited to at-or-below the actor's scope; new accounts shown as **No access**. Absorbs `AdminScreen`'s user table.
2. **Org Structure** — subteams × projects matrix; toggle membership; shared = multi-checked. Subteam add/remove moves here (from `SubteamsPanel`).
3. **Roles & Permissions** — role list incl. **Executive**; Phase A shows the §4 capability matrix read-only (editable in Phase C).

Visibility: exec/owner see all; a lead sees People & Roles filtered to their subteam(s).

### 7.2 Histogram widget (client-only, no backend — shippable independently)
New widget `kind: "histogram"` across `dashboardSettings.ts` (union + `makeWidget` + `normalizeWidget`), `dashboardMetrics.ts` (compute), `DashboardViewClient.tsx` (render + config bar).
- **Computation:** bucket tasks by `start_date` over `[min start … max start]`; y = count starting per bucket. Config: date field (`start`/`due`), granularity (`week`/`month`, auto-default by span), task set. Empty/clamped like existing widgets.
- Tests in `dashboardMetrics.test.ts`.

### 7.3 Photos widget (server-backed, role-gated)
New widget `kind: "photos"`; content from `pm.dashboard_photos` for the current scope; add/replace/remove visible only when `org.can_manage(scope)`; upload via the bucket. Hooks `useDashboardPhotos(scope)`, `useUploadDashboardPhoto`, `useDeleteDashboardPhoto`.

## 8. Migration & verification (the risky part)

- **Preserve current access for existing users** (default-deny applies to *new* signups only). Seed `org.memberships` from `pm.team_memberships` + `pdm.user_roles`:
  - owner → `owner`; PM `admin` / Vault `admin` → `executive`; `lead` → `lead` on every subteam mapped to their project; `engineer`/`editor` → `engineer`; `viewer` → `viewer`.
  - Ambiguous project-scoped → subteam-scoped expansions are **access-preserving** (broaden within the project, never silently drop). Owner refines via the tool afterward.
- Apply via the Supabase **Management API** (pattern of `support.reports`), commit SQL mirrors under `infra/pdm-supabase/supabase/migrations/`, expose `org` schema in PostgREST.
- **Verification gate before the RLS flip:** an automated parity check that *every current user's effective capabilities are ≥ what they had* pre-migration (no lockouts), plus an RLS test suite covering each role × capability across PM, Vault, and `dashboard_photos`.
- Rollback: helpers are shims; revert by repointing them at the old tables (old tables never dropped this release).

## 9. Phasing (build/verify order — still "shipped at once" in v4.4.2)

1. **Histogram widget** + the shared-subsystem bug fix (done) — zero backend, safe.
2. `org` schema + `pm.project_subteams` + helpers (additive, no enforcement).
3. Access-preserving migration into `org.memberships`; run parity verification.
4. "Org & Access" admin UI reads/writes the new tables.
5. **RLS flip** to `org.*` (PM + Vault + photos) — gated on §8 verification.
6. **Dashboard photos** (depends on 5).

(Phase **C**, a later release: make the §4 capability matrix editable in the Roles & Permissions panel, with lockout guardrails.)

## 10. Testing

- **Unit:** histogram metric; `org.*` capability logic; project-subteam mapping reducers; widget normalization.
- **Component:** Org & Access panels (grant scoping, default-deny); histogram + photo widgets (gating).
- **SQL/RLS:** role × capability matrix across `pm`, `pdm`, `dashboard_photos`; storage-bucket policies.
- **Migration parity:** dry-run asserting no existing user loses access.

## 11. Open questions

1. `vp` vs `lead` ordering — assumed **equal** capability for now. Confirm.
2. Canonical subteam table (`pm.subteams` chosen) — confirm the Vault picker can repoint without disrupting existing signups.
3. Exact Vault `admin` → (`executive` vs subteam `lead`) mapping for *per-vault* admins — current plan maps to `executive` (access-preserving) pending Owner review.
