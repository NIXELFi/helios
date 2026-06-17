# RLS Enforcement Cutover — Release-Time Checklist

**Status:** STAGED — do NOT apply until the v4.4.2 release is building (owner's call:
keep enforcement off until then so old clients break only during the build window).

The whole RBAC system is live but **non-enforcing**: `pm.role_memberships` is seeded
(46/46 users) and `pm.has_capability()` works, but no existing Vault/PM policy reads
it yet — current access is unchanged. This cutover repoints the old gates at
`pm.has_capability` so roles finally govern access. It's reversible (old role tables
are retained; the helpers are the only switch).

## Capability mapping
| Old gate | New check |
|----------|-----------|
| `pdm.is_admin_in(vault)` / `pdm.is_admin()` | `pm.has_capability(uid, 'vault.admin', <scope>)` |
| `pdm.can_edit_in(vault)` | `pm.has_capability(uid, 'vault.edit', <scope>)` |
| `pm.is_any_admin(uid)` | `pm.has_capability(uid, 'org.grant_roles', null)` (or a dedicated admin cap) |
| `pm.can_edit_task(uid, task)` | `pm.has_capability(uid, 'pm.edit_tasks', task.subteam_id)` (any of the task's subteams) |
| `support.reports` admin select/update | `pm.has_capability(uid, 'org.grant_roles', null)` |

## ⚠️ Open decision (confirm before applying)
**Vaults aren't tied to subteams**, so `<scope>` for `vault.*` is ambiguous. Pick one:
- **(A) Org-level** — `vault.admin`/`vault.edit` checked org-wide only: Owner/Executive
  administer all vaults; anyone holding `vault.edit` *anywhere* can edit files. Simplest,
  matches "vault isn't really used right now."
- **(B) Per-vault map** — add a `pdm.vault_subteam(vault_id, subteam_id)` table and scope
  the checks to it. More precise, more work.
Recommend **(A)** for this release.

## Repoint list (enumerate ALL consumers — `\df`/grep before writing)
- `pdm.is_admin()`, `pdm.is_admin_in()`, `pdm.can_edit_in()` (folders/files/locks policies + `force_unlock`, `set_revision`, `add_and_lock`, `admin_list_users`, subteam-create RPC).
- `pm.is_any_admin()`, `pm.can_edit_task()`, `pm.pdm_team_role()` (fix the any-vault-admin→pm-admin leak), task/milestone/subteam RLS.
- `support.reports` policies; `storage.objects` policies for `report-attachments`.
- Leave `pm.dashboard_photos`, `storage` dashboard-photos, and the Admin RPCs alone — they already use `has_capability`.

## Parity gate — run and eyeball BEFORE flipping
```sql
-- every current user keeps >= their effective access. Example for vault edit:
select u.id, (pdm.user_roles_has_edit(u.id)) as had_edit,
       pm.has_capability(u.id, 'vault.edit', null) as has_edit_new
from auth.users u
where /* had_edit and not has_edit_new */ ;   -- expect ZERO rows (no one loses edit)
```
Build the equivalent for admin/view across pdm + pm; **zero regressions** required.

## Apply (at release build)
1. Confirm the §Open-decision mapping.
2. Apply `…_rls_flip.sql` via the Management API; commit the mirror.
3. Re-run the parity gate against the flipped state.
4. Smoke-test: Owner can admin; a plain Engineer can edit only their subteam's tasks.

## Rollback (if anything regresses)
Apply `…_rls_flip_rollback.sql` — `create or replace` each helper back to its pre-flip
body (the old `pdm.user_roles` / `pm.team_memberships` tables are untouched). Re-run the
parity gate against the reverted state. No data is lost.
