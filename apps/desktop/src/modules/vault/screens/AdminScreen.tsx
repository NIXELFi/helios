import { useState } from "react";
import { useUser } from "@helios/auth";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { useVaultUsers } from "../data/useVaultUsers";
import { useIsOwner } from "../data/useIsOwner";
import { useIsAdmin } from "../data/useIsAdmin";
import { useSetUserRole } from "../data/useSetUserRole";
import { useRevokeUserRole } from "../data/useRevokeUserRole";
import { useSubteams } from "../data/useSubteams";
import { useManageSubteams } from "../data/useManageSubteams";
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
  const { data: users, loading, error, refetch } = useVaultUsers();
  const setRole = useSetUserRole();
  const revoke = useRevokeUserRole();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Pending revoke awaiting confirmation; null when no dialog is open.
  const [confirmRevoke, setConfirmRevoke] = useState<VaultUser | null>(null);

  async function handleSetRole(u: VaultUser, role: Exclude<VaultRole, "owner">) {
    setPendingId(u.user_id);
    setActionError(null);
    // Consume the RESULT the hook returns — reading setRole.error after the
    // await captures the previous render's value (always stale → generic msg).
    const { ok, error: err } = await setRole.run(u.user_id, role);
    if (!ok) setActionError(err?.message ?? "Failed to set role.");
    else refetch();
    setPendingId(null);
  }

  async function handleRevoke(u: VaultUser) {
    setPendingId(u.user_id);
    setActionError(null);
    const { ok, error: err } = await revoke.run(u.user_id);
    if (!ok) setActionError(err?.message ?? "Failed to revoke role.");
    else refetch();
    setPendingId(null);
  }

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-helios-line bg-helios-base px-4 py-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-asu-gold">Users &amp; roles</div>
          <p className="mt-0.5 text-[10px] text-[#5A5F66]">
            {isOwner
              ? "You're the owner — you can grant any role, including admin."
              : "Admins can grant editor / viewer. Only the owner can grant the admin role."}
          </p>
        </div>
        <button
          type="button"
          onClick={refetch}
          disabled={loading}
          className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
        >
          Refresh
        </button>
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
                <th className="w-[26%]">User</th>
                <th className="w-[18%]">Name</th>
                <th className="w-[16%]">Subteam</th>
                <th className="w-[12%]">Role</th>
                <th className="w-[12%]">Granted</th>
                <th className="w-[16%] text-right">Actions</th>
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
                  anyBusy={pendingId !== null}
                  onSetRole={handleSetRole}
                  onRevoke={(user) => setConfirmRevoke(user)}
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
    const { ok, error } = await manage.remove(id);
    if (!ok) setErr(error?.message ?? "Failed to remove subteam.");
    else refetch();
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
                disabled={manage.removing}
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

function UserRow(props: {
  u: VaultUser;
  isMe: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  busy: boolean;
  anyBusy: boolean;
  onSetRole: (u: VaultUser, role: Exclude<VaultRole, "owner">) => void;
  onRevoke: (u: VaultUser) => void;
}) {
  const { u, isMe, isOwner, isAdmin, busy, anyBusy, onSetRole, onRevoke } = props;

  // Editing rules (mirror the server RPCs):
  //  - your own row: never editable here (prevents self-lockout footguns).
  //  - owner row: never editable here (owner is bootstrap-managed).
  //  - touching an admin row, or assigning admin, needs owner.
  //  - editor/viewer on a non-admin row needs admin.
  const isOwnerRow = u.role === "owner";
  const isAdminRow = u.role === "admin";
  const lockedByOwnership = isOwnerRow || (isAdminRow && !isOwner);
  const editable = isAdmin && !isMe && !lockedByOwnership;

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
        <RoleBadge role={u.role} />
      </td>
      <td className="font-mono-num text-[11px] text-helios-dim">
        {u.granted_at ? new Date(u.granted_at).toLocaleDateString() : "—"}
      </td>
      <td>
        <div className="flex items-center justify-end gap-2">
          <select
            aria-label={`Set role for ${u.email ?? u.user_id}`}
            value={u.role ?? ""}
            disabled={!editable || anyBusy}
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
            disabled={!editable || u.role === null || anyBusy}
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-dim hover:border-red-500/60 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40 disabled:hover:border-helios-line disabled:hover:text-helios-dim"
            title={
              !editable ? lockReason
              : u.role === null ? "No role to revoke"
              : "Remove this user's access"
            }
          >
            {busy ? "…" : "Revoke"}
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
