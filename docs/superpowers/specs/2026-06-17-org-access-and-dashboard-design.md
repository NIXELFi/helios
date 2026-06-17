# Org & Access + Dashboard Customization — Design Spec

- **Date:** 2026-06-17
- **Status:** Draft **Rev 3** (data-driven RBAC; supersedes Rev 1/2)
- **Target release:** v4.4.2 (with the shared-subsystem bug fix already on `feat/v4.4.2-org-access`)
- **Related:** bug fix `8595e90`; feature report "Improved Dashboard Customization" (`support.reports`)

> **Rev history.** Rev 1 invented a standalone `org` schema. Rev 2 (post-review) corrected the premise — the PM schema *already* has subteam-scoped roles (`pm.subteam_memberships` + `pm.effective_role`, season-guarded: `20260602000000_pm_schema.sql:493-547`), unwired in the client. **Rev 3** (owner decision) makes **roles themselves editable data** (a fully-featured role editor), pulls Vault into the same release with a hard rollback requirement, and treats **Lead/VP as two seeded roles with identical capabilities but distinct labels**.

---

## 1. Motivation
The v4.4.2 dashboard report exposed hardcoded/fragmented org structure: subteams are global, EV vs IC isn't modeled, the PM subteam-role engine is dormant, Vault has a separate role system, and **roles/permissions are baked into code** rather than configurable. Principle (locked): **org structure *and roles* are editable data with an admin tool, never hardcoded** ([[no-hardcoded-org-structure]]).

## 2. Current state (verified, live DB `dlmyixonuyckxkknolku`)
- **Projects/seasons:** `SDM26`, `SDM27` (IC), `SDM27e` (EV) — `pm.projects`.
- **Subteams:** 11 global rows in `pm.subteams`; a **separate** `pdm.subteams` drives the Vault signup picker; signup writes subteam as a **free-text name** in `auth.users.raw_user_meta_data` (no FK).
- **PM roles:** enum `pm.team_role`; `pm.team_memberships` (per season) **+ dormant `pm.subteam_memberships`** (global per-subteam override) resolved by `pm.effective_role` (MAX, season-guarded). Client ignores subteam roles.
- **Vault roles:** `pdm.user_roles {owner,admin,editor,viewer}` per-vault, default-deny, UI `vault/screens/AdminScreen.tsx`. Leak: `pm.pdm_team_role` collapses *any* pdm admin → PM admin.
- **Dashboards:** per-user localStorage (`pm/lib/dashboardSettings.ts`).

## 3. Goals / non-goals
**Goals**
1. **Data-driven structure:** subteam → project/program map (`SDM27`/`SDM27e`/shared), editable in-app.
2. **Data-driven RBAC** shared by Vault + PM: roles are rows with editable capabilities; cumulative, **default-deny**, escalation-proof grant rule.
3. **Fully-featured role editor** (create/edit/delete roles, labels, tags, capability toggles) — incl. **Executive** (owner-power) and **Lead + VP** as distinct roles with identical capabilities.
4. **Top-level "Org & Access"** admin surface in the main sidebar (out of the Vault tool).
5. Dashboard **histogram** (client) + **shared photos** (server, role-gated).

**Non-goals (this release):** per-program differentiation of Executive; dropping legacy tables (kept for rollback). *(The editable-matrix work, deferred in Rev 2, is now in-scope per owner decision.)*

## 4. Data-driven role & capability model

### 4.1 Capability catalog (fixed set of toggles the editor exposes)
The only hardcoded part: the capability *keys* the app checks. Roles are arbitrary subsets.

| Key | Meaning | Scope |
|-----|---------|-------|
| `pm.view` | view tasks/dashboards | subteam |
| `pm.edit_tasks` | create/edit tasks | subteam |
| `pm.manage_subsystems` | manage subteam subsystems | subteam |
| `pm.manage_dashboard` | edit shared dashboard + photos | subteam |
| `pm.grant_subteam_roles` | assign roles within a subteam | subteam |
| `org.manage_structure` | edit subteam↔project map + subteam list | org |
| `org.grant_roles` | assign org-wide roles | org |
| `org.manage_roles` | use the role editor (CRUD roles/capabilities) | org |
| `vault.view` / `vault.edit` / `vault.admin` | read / check-in / force-unlock+delete | vault/subteam |
| `vault.grant_roles` | assign vault roles | org |

### 4.2 Roles (seeded, all editable except Owner)
| Role | Tag | Scope | Capabilities (seed) |
|------|-----|-------|---------------------|
| **Owner** | gold | org | **all** — *system role: protected, not editable/deletable, always ≥1* |
| **Executive** | gold | org | all **except** creating owners (enforced by the grant-subset rule, §4.3) |
| **Lead** | green | subteam | pm.view/edit_tasks/manage_subsystems/manage_dashboard/grant_subteam_roles, vault.edit |
| **VP** | teal | subteam | *same as Lead* (distinct label/tag) |
| **Engineer** | slate | subteam | pm.view/edit_tasks, vault.view |
| **Viewer** | grey | subteam | pm.view, vault.view |
| _(no role)_ | — | — | nothing — **default for new accounts** |

### 4.3 Guardrails (escalation-proof, lockout-proof — enforced server-side)
- **Grant-subset rule:** you may grant a role to a user only if that role's capabilities (at that scope) are a **subset of your own** effective capabilities. This *is* "grant-down-only" and makes "only owner grants Executive/Owner" fall out automatically.
- **Edit-subset rule:** you may only set a role's capabilities to a subset of your own — you can't edit a role to gain a capability you lack.
- **Owner protection:** the Owner role can't be edited/deleted; there is always ≥1 Owner; nobody (incl. owner) can revoke their *own* last owner grant.
- **In-use protection:** a role can't be deleted while assigned (reassign first).

## 5. Data model (build on `pm`, no separate schema)
```
pm.capabilities ( key text pk )                     -- the §4.1 catalog (seed/lookup)
pm.roles ( id uuid pk, key text unique, label text, tag text, scope text check (scope in ('org','subteam')),
           is_system boolean default false, sort int, created_by, created_at )
pm.role_capabilities ( role_id uuid, capability_key text, pk(role_id, capability_key) )
pm.role_memberships ( user_id uuid, role_id uuid, subteam_id uuid null,   -- NULL = org-scoped role
                      granted_by, granted_at, unique(user_id, role_id, coalesce(subteam_id,'0…')) )
pm.project_subteams ( project_id, subteam_id, pk(project_id, subteam_id) )   -- the EV/IC map; shared = ≥2
```
- **Resolver:** `pm.has_capability(uid, cap_key, subteam_id)` — true if any of the user's role_memberships (org-scoped OR for this subteam) maps to `cap_key`. Org-scoped capabilities apply everywhere; subteam capabilities only in that subteam. (Replaces the enum-based `effective_role`; `pm.subteam_memberships`/`team_memberships` are migrated into `role_memberships`, §8.)
- **Shared by Vault:** `pdm.is_admin*`/`can_edit_in` delegate to `pm.has_capability(... 'vault.admin'/'vault.edit' ...)` so one model governs both (no two-sources-of-truth).
- **Client payload:** `pm.my_capabilities()` → the caller's effective capability set per scope, so the UI mirrors RLS (rewrites `selectCanEditTask`/`selectIsAdmin`; a task's effective set = union over its subteams).
- **Subteam-table reconciliation** (`pm.subteams` canonical; backfill the free-text signup names → ids; unmapped user = parity failure) remains a required workstream (§8).

## 5b. Dashboard photos
Bucket `dashboard-photos` (private), path `{project_id}/{subteam_id|all}/{uuid}` so the storage policy can parse + gate by subteam. Table `pm.dashboard_photos(id, project_id, subteam_id null, storage_path, caption, sort_order, created_by, created_at)`. RLS: select = `pm.view` in scope; write = `pm.manage_dashboard` in scope; storage policy mirrors via the path.

## 6. RLS cutover & rollback (hard requirement)
- Repoint **every** consumer of old gates to `pm.has_capability`: `pdm.is_admin()`+dependents (`force_unlock`, `admin_list_users`, subteam-create, `support.reports` policies, storage), `pm.is_any_admin`, **`pm.pdm_team_role`** (fix the any-vault-admin leak), `pm.can_edit_task`. Enumerate each; parity test covers all.
- **Rollback:** keep old tables/helpers intact; the new helpers are the only switch. A single revert migration repoints helpers back to the enum tables. Validated by re-running the parity suite against the reverted state.
- **Owner bootstrap/break-glass:** a service-role seed RPC sets the first Owner; "can't drop your own last owner" prevents self-lockout.

## 7. Frontend
**7.1 "Org & Access" sidebar section** (shared, top-level):
- **People & Roles** — assign roles to users at a scope; grant options filtered by the grant-subset rule; new accounts show *No access*; grant **audit** recorded. Absorbs `AdminScreen`'s table.
- **Org Structure** — subteams × projects matrix (shared = multi); subteam add/remove moves here from `SubteamsPanel`.
- **Role Editor** — CRUD roles, label + tag, capability checkboxes (disabled for caps you lack); Owner shown read-only; "in use by N" guard on delete.

**7.2 Histogram widget** (client-only, **ships independently**): `kind:"histogram"` in `dashboardSettings.ts` (union + `makeWidget` + `normalizeWidget`), `dashboardMetrics.ts` (counts bucketed by `start_date` over `[min…max]`; config: date field, week/month granularity auto, task set), `DashboardViewClient.tsx` (render + config bar). Tests in `dashboardMetrics.test.ts`.

**7.3 Photos widget** (server, role-gated): `kind:"photos"`; content from `pm.dashboard_photos`; add/replace/remove visible only with `pm.manage_dashboard` in scope; hooks `useDashboardPhotos/useUpload/useDelete`.

## 8. Migration & verification
- **Preserve existing access** (default-deny for *new* signups only). Map **all three** sources into `pm.role_memberships`: `pm.team_memberships`, **`pm.subteam_memberships`** (must NOT be dropped), `pdm.user_roles`. owner→Owner; global Vault admin / PM admin→Executive; **per-vault Vault admin→Lead on that vault's subteams** (not Executive); lead→Lead; engineer/editor→Engineer; viewer→Viewer. Project-leads keep edit access but **not** org-wide grant power (grant power is default-deny until explicitly assigned).
- Apply via Supabase **Management API** (`support.reports` precedent); commit SQL mirrors under `infra/pdm-supabase/supabase/migrations/`; **explicitly expose new objects in PostgREST** (checklist item — has bitten every prior rollout).
- **Verification gate before the RLS flip:** parity check that every current user's effective capabilities (view/edit **and grant**) are ≥ pre-migration; RLS suite over capability × role across `pm`/`pdm`/`dashboard_photos`; unmapped subteam name = fail.

## 9. Phasing (build/verify order — all lands in v4.4.2)
1. **Histogram widget** + bug fix (done) — zero backend, safe.
2. Schema: `capabilities`/`roles`/`role_capabilities`/`role_memberships`/`project_subteams` (+ seed roles §4.2) + `has_capability`/`my_capabilities` (additive, no enforcement).
3. Subteam-table reconciliation + access-preserving migration (§8); parity verification.
4. "Org & Access" UI (People & Roles, Org Structure, Role Editor) + grant audit.
5. **RLS flip** to `has_capability` (PM + Vault + photos), gated on §8; rollback migration prepared.
6. **Dashboard photos** (depends on 5).

## 10. Testing
Unit (histogram metric; `has_capability` + grant/edit-subset logic; mapping reducers; widget normalization); component (Org & Access panels — grant-subset filtering, default-deny, role-editor disabled-cap rules; widgets); SQL/RLS (capability × role across `pm`/`pdm`/`dashboard_photos` + storage path policy); **migration parity** (no lost view/edit/grant; no unmapped subteam); **rollback** (parity suite passes against reverted state).

## 11. Open questions
1. Capability catalog (§4.1) — is the granularity right, or split `vault.admin` into force-unlock vs delete? (Default: keep coarse for v1.)
2. Does a subteam-scoped role's `vault.*` capability map to a **per-vault** grant (which vault corresponds to which subteam/season)? Vault↔subteam/season mapping needs confirming during step 3.
