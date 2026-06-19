import { useState } from "react";
import { useUser } from "@helios/auth";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useVaultUsers } from "../data/useVaultUsers";
import { useVaults } from "../data/useVaults";
import { useIsOwner } from "../data/useIsOwner";
import { useIsAdmin } from "../data/useIsAdmin";
import { useSetUserRole } from "../data/useSetUserRole";
import { useRevokeUserRole } from "../data/useRevokeUserRole";
import { useUpdateUser } from "../data/useUpdateUser";
import { useDeleteUser } from "../data/useDeleteUser";
import { useSubteams } from "../data/useSubteams";
import { useManageSubteams } from "../data/useManageSubteams";
import { EditUserDialog } from "../components/EditUserDialog";
import type { VaultRole, VaultUser } from "../data/types";

const ASSIGNABLE: Exclude<VaultRole, "owner">[] = ["viewer", "editor", "admin"];

/** Standardized wording for a user who hasn't been granted any vault role.
 *  Previously this was spelled three different ways ("no access" / "— none —" /
 *  "(no role assigned)") across the admin/settings screens. */
const NO_ROLE_LABEL = "no access";

/** Admin-only user management. Lists every account + role and lets admins
 *  grant/revoke roles. Authorization is enforced server-side by the
 *  pdm_set_user_role / pdm_revoke_user_role RPCs; this UI mirrors the hybrid
 *  rules (only the owner can touch the admin role) purely for affordance. */
export function AdminScreen() {
  const me = useUser();
  const isAdmin = useIsAdmin();
  const isOwner = useIsOwner();
  const { data: vaults } = useVaults();
  // Scope: null = GLOBAL roles (apply to every vault); a vault id = that
  // vault's effective roles. Grants/revokes target the chosen scope.
  const [scopeVaultId, setScopeVaultId] = useState<string | null>(null);
  const { data: users, loading, error, refetch } = useVaultUsers(scopeVaultId);
  const setRole = useSetUserRole();
  const revoke = useRevokeUserRole();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const { data: subteams } = useSubteams();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Pending revoke awaiting confirmation; null when no dialog is open.
  const [confirmRevoke, setConfirmRevoke] = useState<VaultUser | null>(null);
  // Profile-edit dialog target / delete-confirmation target.
  const [editingUser, setEditingUser] = useState<VaultUser | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VaultUser | null>(null);

  async function handleSetRole(u: VaultUser, role: Exclude<VaultRole, "owner">) {
    setPendingId(u.user_id);
    setActionError(null);
    // Consume the RESULT the hook returns — reading setRole.error after the
    // await captures the previous render's value (always stale → generic msg).
    const { ok, error: err } = await setRole.run(u.user_id, role, scopeVaultId);
    if (!ok) setActionError(err?.message ?? "Failed to set role.");
    else refetch();
    setPendingId(null);
  }

  async function handleRevoke(u: VaultUser) {
    setPendingId(u.user_id);
    setActionError(null);
    const { ok, error: err } = await revoke.run(u.user_id, scopeVaultId);
    if (!ok) setActionError(err?.message ?? "Failed to revoke role.");
    else refetch();
    setPendingId(null);
  }

  async function handleSaveProfile(u: VaultUser, name: string | null, subteam: string | null) {
    setPendingId(u.user_id);
    setActionError(null);
    const { ok, error: err } = await updateUser.run(u.user_id, name, subteam);
    if (!ok) setActionError(err?.message ?? "Failed to update user.");
    else { setEditingUser(null); refetch(); }
    setPendingId(null);
  }

  async function handleDelete(u: VaultUser) {
    setPendingId(u.user_id);
    setActionError(null);
    const { ok, error: err } = await deleteUser.run(u.user_id);
    if (!ok) setActionError(err?.message ?? "Failed to delete user.");
    else refetch();
    setPendingId(null);
  }

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-helios-line bg-helios-base px-4 py-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-asu-gold">Users &amp; roles</div>
          <p className="mt-0.5 text-[10px] text-[#5A5F66]">
            {scopeVaultId
              ? "Roles scoped to this vault. A global role still applies here unless overridden."
              : isOwner
                ? "Global roles apply to every vault. You're the owner — you can grant any role, including admin."
                : "Global roles apply to every vault. Admins can grant editor / viewer. Only the owner can grant the admin role."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#5A5F66]">
            Scope
            <select
              aria-label="Role scope"
              value={scopeVaultId ?? ""}
              onChange={(e) => setScopeVaultId(e.target.value || null)}
              className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold"
            >
              <option value="">Global (all vaults)</option>
              {(vaults ?? []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
        <button
          type="button"
          onClick={refetch}
          disabled={loading}
          className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
        >
          Refresh
        </button>
        </div>
      </header>

      {actionError && (
        <div className="flex-shrink-0 border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-200" role="alert">
          {actionError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 text-sm text-helios-dim">Loading users…</div>
        ) : error ? (
          <div className="m-4 rounded-sm border border-red-500/40 bg-red-500/10 p-4 text-[12px] text-red-200">
            {error.message}
          </div>
        ) : (
          <table className="w-full table-fixed text-left text-[12px]">
            <thead className="sticky top-0 bg-helios-base text-[10px] uppercase tracking-wider text-[#5A5F66]">
              <tr className="border-b border-helios-line [&>th]:px-4 [&>th]:py-2 [&>th]:font-normal">
                <th className="w-[22%]">User</th>
                <th className="w-[15%]">Name</th>
                <th className="w-[13%]">Subteam</th>
                <th className="w-[10%]">Role</th>
                <th className="w-[10%]">Granted</th>
                <th className="w-[30%] text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <UserRow
                  key={u.user_id}
                  u={u}
                  isMe={u.user_id === me?.id}
                  isOwner={isOwner}
                  isAdmin={isAdmin}
                  busy={pendingId === u.user_id}
                  vaultScoped={scopeVaultId !== null}
                  onSetRole={handleSetRole}
                  onRevoke={(user) => setConfirmRevoke(user)}
                  onEdit={(user) => setEditingUser(user)}
                  onDelete={(user) => setConfirmDelete(user)}
                />
              ))}
              {(users ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[11px] text-helios-dim">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {/* Subteam management — any admin (incl. owner) can add/remove. */}
        <SubteamsPanel canManage={isAdmin} />
      </div>

      {confirmRevoke && (
        <ConfirmDialog
          title="Revoke access"
          body={
            <>
              Remove <span className="font-semibold">{confirmRevoke.email ?? confirmRevoke.user_id}</span>'s
              access to this vault? They'll keep their account but lose all role-gated actions until re-granted.
            </>
          }
          confirmLabel="Revoke access"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => {
            const u = confirmRevoke;
            setConfirmRevoke(null);
            handleRevoke(u);
          }}
          onClose={() => setConfirmRevoke(null)}
        />
      )}

      {editingUser && (
        <EditUserDialog
          user={editingUser}
          subteams={subteams ?? []}
          saving={pendingId === editingUser.user_id}
          onSave={(name, subteam) => handleSaveProfile(editingUser, name, subteam)}
          onClose={() => setEditingUser(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete account"
          body={
            <>
              Permanently delete <span className="font-semibold">{confirmDelete.email ?? confirmDelete.user_id}</span>?
              This removes their account and access for good, releases any files they have checked out, and
              un-assigns work they created. Authorship history is preserved (shown as an unknown user).
              <span className="mt-2 block text-red-300">This cannot be undone.</span>
            </>
          }
          confirmLabel="Delete account"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => {
            const u = confirmDelete;
            setConfirmDelete(null);
            handleDelete(u);
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function SubteamsPanel({ canManage }: { canManage: boolean }) {
  const { data: subteams, loading, refetch } = useSubteams();
  const manage = useManageSubteams();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Subteam pending removal awaiting confirmation.
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null);
  // Which subteam id has an in-flight remove. `manage.removing` is a single
  // shared flag that would disable EVERY ✕ during any one removal; tracking the
  // targeted id keeps the other ✕ buttons clickable (per-row, like UserRow).
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setErr(null);
    const { ok, error } = await manage.create(name.trim());
    if (!ok) { setErr(error?.message ?? "Failed to add subteam."); return; }
    setName("");
    refetch();
  }

  async function remove(id: string) {
    setErr(null);
    setRemovingId(id);
    const { ok, error } = await manage.remove(id);
    if (!ok) setErr(error?.message ?? "Failed to remove subteam.");
    else refetch();
    setRemovingId(null);
  }

  return (
    <div className="border-t border-helios-line p-4">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-asu-gold">Subteams</div>
      <p className="mb-3 text-[10px] text-[#5A5F66]">
        Every account picks one of these at sign-up. {canManage ? "Add or remove subteams below." : "Only admins can change this list."}
      </p>
      {err && <p className="mb-2 text-[11px] text-red-300" role="alert">{err}</p>}
      <div className="flex flex-wrap gap-1.5">
        {loading && <span className="text-[11px] text-helios-dim">Loading…</span>}
        {(subteams ?? []).map((s) => (
          <span key={s.id} className="flex items-center gap-1.5 rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text">
            {s.name}
            {canManage && (
              <button
                type="button"
                aria-label={`Remove ${s.name}`}
                title={`Remove ${s.name}`}
                onClick={() => setConfirmRemove({ id: s.id, name: s.name })}
                disabled={removingId === s.id}
                className="text-[10px] text-helios-dim hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
              >✕</button>
            )}
          </span>
        ))}
      </div>
      {canManage && (
        <form onSubmit={add} className="mt-3 flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New subteam name"
            aria-label="New subteam name"
            className="w-56 rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] text-helios-text outline-none focus:border-asu-gold"
          />
          <button
            type="submit"
            // Only the create flow disables Add — a pending remove no longer
            // blocks adding (separate `creating`/`removing` loading flags).
            disabled={manage.creating || !name.trim()}
            className="rounded-sm bg-asu-gold px-2.5 py-1 text-[11px] font-semibold text-helios-base hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            Add
          </button>
        </form>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove subteam"
          body={
            <>
              Remove the subteam <span className="font-semibold">{confirmRemove.name}</span>? Accounts that
              picked it keep their existing choice, but it won't be offered to new sign-ups.
            </>
          }
          confirmLabel="Remove"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => {
            const id = confirmRemove.id;
            setConfirmRemove(null);
            remove(id);
          }}
          onClose={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

/** Pure helper — determines whether an admin may click Edit on a user row.
 *  Mirrors the `editable` predicate used by the Revoke / role-select controls
 *  (lines 370-373) and adds the pre-existing busy + vaultScoped guards.
 *
 *  lockedByOwnership = isOwnerRow || (isAdminRow && !isOwner)
 *  editable          = isAdmin && !isMe && !lockedByOwnership
 *  canEdit           = editable && !busy && !vaultScoped
 */
export function canEditUserProfile(opts: {
  isAdmin: boolean;
  isOwner: boolean;
  isOwnerRow: boolean;
  isMe: boolean;
  busy: boolean;
  vaultScoped: boolean;
  isAdminRow?: boolean;
}): boolean {
  const { isAdmin, isOwner, isOwnerRow, isMe, busy, vaultScoped, isAdminRow = false } = opts;
  const lockedByOwnership = isOwnerRow || (isAdminRow && !isOwner);
  const editable = isAdmin && !isMe && !lockedByOwnership;
  return editable && !busy && !vaultScoped;
}

function UserRow(props: {
  u: VaultUser;
  isMe: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  busy: boolean;
  /** True when the table is scoped to a single vault. The per-vault roles RPC
   *  doesn't return display_name/subteam (those are account-wide), so editing a
   *  profile here would save blanks over the real values — disable Edit. */
  vaultScoped: boolean;
  onSetRole: (u: VaultUser, role: Exclude<VaultRole, "owner">) => void;
  onRevoke: (u: VaultUser) => void;
  onEdit: (u: VaultUser) => void;
  onDelete: (u: VaultUser) => void;
}) {
  const { u, isMe, isOwner, isAdmin, busy, vaultScoped, onSetRole, onRevoke, onEdit, onDelete } = props;

  // In a vault-scoped view, a role with scope "global" is INHERITED from the
  // user's global role — there's no per-vault override row to remove, so Revoke
  // would be a no-op (or revoke the global role across every vault). Set a
  // per-vault role first to override it; only then is there something to revoke
  // here. The global list never sets `scope`, so this is false there.
  const inherited = vaultScoped && u.role !== null && u.scope !== "vault";

  // Editing rules (mirror the server RPCs):
  //  - your own row: never editable here (prevents self-lockout footguns).
  //  - owner row: never editable here (owner is bootstrap-managed).
  //  - touching an admin row, or assigning admin, needs owner.
  //  - editor/viewer on a non-admin row needs admin.
  const isOwnerRow = u.role === "owner";
  const isAdminRow = u.role === "admin";
  const lockedByOwnership = isOwnerRow || (isAdminRow && !isOwner);
  const editable = isAdmin && !isMe && !lockedByOwnership;
  // Deletion mirrors the server guards: admins only, never yourself or the
  // owner, and an admin row can only be deleted by the owner.
  const deletable = isAdmin && !isMe && !isOwnerRow && (!isAdminRow || isOwner);
  const deleteReason = isMe
    ? "You can't delete your own account."
    : isOwnerRow
      ? "The owner account can't be deleted here."
      : isAdminRow && !isOwner
        ? "Only the owner can delete an admin."
        : !isAdmin
          ? "Only admins can delete users."
          : "Permanently delete this account.";

  // Explain WHY a row's controls are disabled so the locked state isn't a
  // mystery (V17). Empty string when the row is editable.
  const lockReason = isMe
    ? "You can't change your own role here."
    : isOwnerRow
      ? "The owner role is managed by the bootstrap script, not here."
      : isAdminRow && !isOwner
        ? "Only the owner can change an admin's role."
        : !isAdmin
          ? "Only admins can change roles."
          : "";

  return (
    <tr className="border-b border-helios-line/60 [&>td]:px-4 [&>td]:py-2" title={lockReason || undefined}>
      <td className="truncate">
        <span className="text-helios-text" title={u.email ?? "(unknown email)"}>{u.email ?? "(unknown email)"}</span>
        {isMe && <span className="ml-1.5 text-[10px] text-asu-gold">(you)</span>}
      </td>
      <td className="truncate text-helios-text" title={u.display_name ?? undefined}>
        {u.display_name ?? <span className="text-[#5A5F66]">—</span>}
      </td>
      <td className="truncate text-helios-dim" title={u.subteam ?? undefined}>
        {u.subteam ?? <span className="text-[#5A5F66]">—</span>}
      </td>
      <td>
        <div className="flex items-center gap-1.5">
          <RoleBadge role={u.role} />
          {vaultScoped && u.role !== null && (
            <span
              className={
                "rounded-sm border px-1 py-0.5 text-[9px] uppercase tracking-wider " +
                (inherited ? "border-helios-line text-[#5A5F66]" : "border-asu-gold/60 text-asu-gold")
              }
              title={inherited
                ? "Inherited from this user's global role — set a per-vault role to override it"
                : "A per-vault override role for this vault"}
            >
              {inherited ? "inherited" : "override"}
            </span>
          )}
        </div>
      </td>
      <td className="font-mono-num text-[11px] text-helios-dim">
        {u.granted_at ? new Date(u.granted_at).toLocaleDateString() : "—"}
      </td>
      <td>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <select
            aria-label={`Set role for ${u.email ?? u.user_id}`}
            value={u.role ?? ""}
            // Disable only THIS row while ITS own mutation is in flight (busy),
            // not every row during any single mutation (the old anyBusy flag).
            disabled={!editable || busy}
            title={!editable ? lockReason : undefined}
            onChange={(e) => {
              const v = e.target.value as Exclude<VaultRole, "owner">;
              if (v) onSetRole(u, v);
            }}
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text outline-none focus:border-asu-gold disabled:opacity-40"
          >
            {u.role === null && <option value="">{NO_ROLE_LABEL}</option>}
            {isOwnerRow && <option value="owner">owner</option>}
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r} disabled={r === "admin" && !isOwner}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onRevoke(u)}
            disabled={!editable || u.role === null || inherited || busy}
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-dim hover:border-red-500/60 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40 disabled:hover:border-helios-line disabled:hover:text-helios-dim"
            title={
              !editable ? lockReason
              : u.role === null ? "No role to revoke"
              : inherited ? "Inherited from the global role — nothing to revoke in this vault. Set a per-vault role first to override it, or revoke the global role under the Global scope."
              : "Remove this user's access"
            }
          >
            {busy ? "…" : "Revoke"}
          </button>
          <button
            type="button"
            onClick={() => onEdit(u)}
            disabled={!canEditUserProfile({ isAdmin, isOwner, isOwnerRow, isMe, busy, vaultScoped, isAdminRow })}
            title={vaultScoped
              ? "Switch the scope to Global to edit name & subteam — the per-vault list doesn't load them, so saving here would blank the real values"
              : !editable
                ? lockReason
                : "Edit name & subteam"}
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-dim hover:border-asu-gold hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(u)}
            disabled={!deletable || busy}
            title={deleteReason}
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-dim hover:border-red-500/60 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40 disabled:hover:border-helios-line disabled:hover:text-helios-dim"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function RoleBadge({ role }: { role: VaultRole | null }) {
  if (role === null) {
    return <span className="rounded-sm border border-helios-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#5A5F66]">{NO_ROLE_LABEL}</span>;
  }
  const tone =
    role === "owner" ? "border-asu-gold bg-asu-gold text-helios-base"
    : role === "admin" ? "border-asu-gold text-asu-gold"
    : role === "editor" ? "border-helios-line text-helios-text"
    : "border-helios-line text-helios-dim";
  return (
    <span className={"rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider " + tone}>
      {role}
    </span>
  );
}
