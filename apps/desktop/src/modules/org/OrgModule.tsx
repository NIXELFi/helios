import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconBolt,
  IconDeviceFloppy,
  IconEngine,
  IconPencil,
  IconPlus,
  IconSearch,
  IconShieldLock,
  IconSitemap,
  IconTrash,
  IconUserPlus,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { useSupabaseClient, useUser } from "@helios/auth";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  useCapabilities,
  useMyCapabilities,
  usePeople,
  useProjects,
  useProjectSubteams,
  useRolesWithCaps,
  useSubteams,
  grantableCapsPayload,
  roleCapsHeldInScope,
  type Capability,
  type Person,
  type RoleWithCaps,
} from "./data/useOrgData";
import { useOrgMutations } from "./data/useOrgMutations";

type Tab = "people" | "structure" | "roles";

const TABS: { id: Tab; label: string; Icon: typeof IconUsers }[] = [
  { id: "people", label: "People & Roles", Icon: IconUsers },
  { id: "structure", label: "Org Structure", Icon: IconSitemap },
  { id: "roles", label: "Role Editor", Icon: IconShieldLock },
];

export function OrgModule() {
  const [tab, setTab] = useState<Tab>("people");
  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 flex-col gap-3 border-b border-helios-line px-5 pt-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-asu-gold/30 bg-asu-gold/15 text-asu-gold"
          >
            <IconShieldLock size={20} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight text-helios-text">Admin</h1>
            <p className="mt-0.5 text-[11px] leading-tight text-helios-dim">
              People, roles, and the subteam ↔ project map — shared across Vault and PM.
            </p>
          </div>
        </div>
        <nav className="-mb-px flex gap-0.5" aria-label="Admin sections">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={
                  "group inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                  (active
                    ? "border-asu-gold text-asu-gold"
                    : "border-transparent text-helios-dim hover:text-helios-text")
                }
              >
                <t.Icon size={15} strokeWidth={1.75} className={active ? "" : "opacity-70 group-hover:opacity-100"} />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "people" && <PeopleRolesPanel />}
        {tab === "structure" && <StructurePanel />}
        {tab === "roles" && <RoleEditorPanel />}
      </div>
    </div>
  );
}

// --- Shared presentational helpers ------------------------------------------

/** Two-letter initials from a display name or email, for the row avatars. */
function initialsOf(person: Person): string {
  const name = person.display_name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const email = person.email?.trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return "??";
}

/** A small circular initials avatar; deterministically tinted off the user id. */
function Avatar({ person }: { person: Person }) {
  const hue = useMemo(() => {
    let h = 0;
    const s = person.user_id || person.email || "?";
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }, [person.user_id, person.email]);
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-semibold tracking-wide"
      style={{
        backgroundColor: `hsl(${hue} 45% 22%)`,
        color: `hsl(${hue} 70% 78%)`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      {initialsOf(person)}
    </span>
  );
}

/** Small uppercase section label used to head each panel. */
function SectionHeader({
  icon,
  title,
  hint,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-helios-text">
          <span aria-hidden className="text-helios-dim">
            {icon}
          </span>
          {title}
        </div>
        {hint ? <p className="mt-1 text-[11px] leading-relaxed text-helios-dim">{hint}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

interface Subteam {
  id: string;
  name: string;
  code: string;
}

function PeopleRolesPanel() {
  const client = useSupabaseClient();
  const me = useUser();
  const { data: people, loading, error, refetch } = usePeople();
  // Pull each role's capability set too, so we can apply the server's
  // grant-subset rule client-side (only offer roles the granter can actually
  // grant) instead of always failing the RPC.
  const { data: roles } = useRolesWithCaps();
  const { can, refetch: refetchMyCaps } = useMyCapabilities();
  const { grantRole, revokeRole, updatePerson, deletePerson } = useOrgMutations();
  // Pending account deletion awaiting the confirm dialog; null = closed.
  const [confirmDelete, setConfirmDelete] = useState<Person | null>(null);

  const [subteams, setSubteams] = useState<Subteam[]>([]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await client.schema("pm").from("subteams").select("id,name,code").order("name");
      if (mounted) setSubteams((data as Subteam[]) ?? []);
    })();
    return () => {
      mounted = false;
    };
  }, [client]);

  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Local presentational filter over the already-loaded directory (name/email).
  const [search, setSearch] = useState("");

  const subteamName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of subteams) m.set(s.id, s.name);
    return m;
  }, [subteams]);

  const filtered = useMemo(() => {
    const list = people ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        (p.display_name ?? "").toLowerCase().includes(q) ||
        (p.email ?? "").toLowerCase().includes(q) ||
        (p.signup_subteam ?? "").toLowerCase().includes(q),
    );
  }, [people, search]);

  async function doGrant(target: string, roleKey: string, subteamId: string | null) {
    setBusyUser(target);
    setActionError(null);
    const r = await grantRole(target, roleKey, subteamId);
    if (!r.ok) setActionError(r.error);
    else {
      refetch();
      // If the granter just changed their own roles, refresh their capabilities
      // so the UI grant/revoke gates reflect it without a reload.
      refetchMyCaps();
    }
    setBusyUser(null);
  }
  async function doRevoke(target: string, roleKey: string, subteamId: string | null) {
    setBusyUser(target);
    setActionError(null);
    const r = await revokeRole(target, roleKey, subteamId);
    if (!r.ok) setActionError(r.error);
    else {
      refetch();
      refetchMyCaps();
    }
    setBusyUser(null);
  }
  async function doUpdate(target: string, name: string | null, subteam: string | null) {
    setBusyUser(target);
    setActionError(null);
    const r = await updatePerson(target, name, subteam);
    if (!r.ok) setActionError(r.error);
    else refetch();
    setBusyUser(null);
  }
  async function doDelete(target: string) {
    setBusyUser(target);
    setActionError(null);
    const r = await deletePerson(target);
    if (!r.ok) setActionError(r.error);
    else refetch();
    setBusyUser(null);
  }

  const total = (people ?? []).length;

  return (
    <div className="p-4">
      <SectionHeader
        icon={<IconUsers size={14} strokeWidth={1.75} />}
        title="People & Roles"
        hint="Grant or revoke org-wide and per-subteam roles. Subteam roles are one rank per subteam."
        right={
          !loading && !error ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-helios-line bg-helios-panel px-2.5 py-1 text-[11px] tabular-nums text-helios-dim">
              <IconUsers size={12} strokeWidth={1.75} aria-hidden />
              {total} {total === 1 ? "person" : "people"}
            </span>
          ) : undefined
        }
      />

      {!loading && !error && (
        <label className="relative mb-3 block">
          <IconSearch
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-helios-dim"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or subteam…"
            aria-label="Search people"
            className="w-full max-w-sm rounded-md border border-helios-line bg-helios-panel py-1.5 pl-8 pr-3 text-[12px] text-helios-text placeholder:text-helios-dim outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
          />
        </label>
      )}

      {actionError && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">
          {actionError}
        </div>
      )}
      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-[12px] text-red-200" role="alert">
          {error.message}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 rounded-md border border-helios-line bg-helios-panel p-6 text-sm text-helios-dim">
          <span aria-hidden className="size-3 animate-pulse rounded-full bg-asu-gold/60" />
          Loading people…
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-helios-line">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-helios-panel/95 text-[10px] uppercase tracking-wider text-helios-dim backdrop-blur">
              <tr className="border-b border-helios-line [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium">
                <th className="w-[26%]">User</th>
                <th className="w-[14%]">Signup subteam</th>
                <th>Roles</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <PersonRow
                  key={p.user_id}
                  person={p}
                  roles={roles ?? []}
                  subteams={subteams}
                  subteamName={subteamName}
                  busy={busyUser === p.user_id}
                  isMe={p.user_id === me?.id}
                  can={can}
                  onGrant={doGrant}
                  onRevoke={doRevoke}
                  onUpdate={doUpdate}
                  onDelete={(person) => setConfirmDelete(person)}
                />
              ))}
              {total === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-10 text-center text-[11px] text-helios-dim">
                    No accounts yet.
                  </td>
                </tr>
              )}
              {total > 0 && filtered.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-10 text-center text-[11px] text-helios-dim">
                    No one matches “{search.trim()}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete account"
          body={
            <>
              Permanently delete{" "}
              <span className="font-semibold">
                {confirmDelete.display_name ?? confirmDelete.email ?? confirmDelete.user_id}
              </span>
              ? This removes their account and access for good, releases any files they have
              checked out, and un-assigns work they created. Authorship history is preserved
              (shown as an unknown user).
              <span className="mt-2 block text-red-300">This cannot be undone.</span>
            </>
          }
          confirmLabel="Delete account"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => {
            const p = confirmDelete;
            setConfirmDelete(null);
            doDelete(p.user_id);
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function PersonRow(props: {
  person: Person;
  roles: RoleWithCaps[];
  subteams: Subteam[];
  subteamName: Map<string, string>;
  busy: boolean;
  isMe: boolean;
  can: (cap: string, subteamId?: string | null) => boolean;
  onGrant: (target: string, roleKey: string, subteamId: string | null) => void;
  onRevoke: (target: string, roleKey: string, subteamId: string | null) => void;
  onUpdate: (target: string, name: string | null, subteam: string | null) => void;
  onDelete: (person: Person) => void;
}) {
  const { person, roles, subteams, subteamName, busy, isMe, can, onGrant, onRevoke, onUpdate, onDelete } = props;
  const [adding, setAdding] = useState(false);
  const [roleKey, setRoleKey] = useState("");
  const [subteamId, setSubteamId] = useState("");
  const canManagePeople = can("org.grant_roles");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(person.display_name ?? "");
  const [editSubteam, setEditSubteam] = useState(person.signup_subteam ?? "");

  // Client mirror of the server's admin-tier delete/edit guard (20260721000100):
  // a target holding an org-scoped role that carries org.grant_roles or
  // org.manage_admins is owner-managed. Legacy-only pdm admin rows aren't
  // visible from here — the server still refuses those; this only shapes the
  // tooltip so the refusal isn't a surprise.
  const targetIsAdminTier = useMemo(
    () =>
      person.roles.some((pr) => {
        if (pr.scope !== "org") return false;
        const caps = roles.find((r) => r.key === pr.role)?.capabilities ?? [];
        return caps.includes("org.grant_roles") || caps.includes("org.manage_admins");
      }),
    [person.roles, roles],
  );
  const deleteTitle = isMe
    ? "You can't delete your own account."
    : targetIsAdminTier
      ? "Admin-tier account — only the owner can delete it."
      : "Permanently delete this account…";

  // Subteam options for the editor: the real subteams, plus the current value if
  // it's a legacy/free-text one (e.g. "President") so editing never loses it.
  const subteamOptions = useMemo(() => {
    const names = subteams.map((s) => s.name);
    const cur = person.signup_subteam?.trim();
    return cur && !names.includes(cur) ? [cur, ...names] : names;
  }, [subteams, person.signup_subteam]);

  function startEdit() {
    setEditName(person.display_name ?? "");
    setEditSubteam(person.signup_subteam ?? "");
    setEditing(true);
  }
  function saveEdit() {
    onUpdate(person.user_id, editName.trim() || null, editSubteam.trim() || null);
    setEditing(false);
  }

  // Only offer actions the server would actually accept. An org granter can
  // grant any role org-wide; a subteam-only granter can grant just the
  // subteam-scoped roles, and only into subteams it holds the grant cap for.
  const isOrgGranter = can("org.grant_roles");
  const grantableSubteams = useMemo(
    () =>
      isOrgGranter ? subteams : subteams.filter((s) => can("pm.grant_subteam_roles", s.id)),
    [subteams, isOrgGranter, can],
  );

  // Server-side grant-subset rule (pm.grant_role): the role's capability set
  // must be a subset of what the granter holds in the target scope. Mirror it
  // client-side so we never offer a role the RPC would reject.
  //   - org role into org scope → every cap must be held org-wide
  //   - subteam role into subteam S → every cap must be held in scope S
  //     (an org-wide grant of a cap counts in every subteam, per `can`)
  const grantableInScope = useCallback(
    (r: RoleWithCaps, scopeSubteamId: string | null) =>
      roleCapsHeldInScope(r.capabilities, can, scopeSubteamId),
    [can],
  );

  // Subteams this role could actually be granted into (caps-subset satisfied).
  const subteamsForRole = useCallback(
    (r: RoleWithCaps) => grantableSubteams.filter((s) => grantableInScope(r, s.id)),
    [grantableSubteams, grantableInScope],
  );

  // The owner/executive org roles have an extra server gate (org.manage_admins)
  // beyond the caps-subset rule; only offer them when the granter holds it.
  const canGrantAdmins = can("org.manage_admins");
  const grantableRoles = useMemo(() => {
    const base = isOrgGranter ? roles : roles.filter((r) => r.scope === "subteam");
    return base.filter((r) => {
      if (r.scope === "org") {
        if ((r.key === "owner" || r.key === "executive") && !canGrantAdmins) return false;
        return grantableInScope(r, null);
      }
      // A subteam role is offerable only if there's at least one subteam the
      // granter can grant it into; if a subteam is already picked, it must be
      // grantable specifically there.
      if (subteamId) return grantableInScope(r, subteamId);
      return subteamsForRole(r).length > 0;
    });
  }, [roles, isOrgGranter, grantableInScope, subteamId, subteamsForRole, canGrantAdmins]);

  const selectedRole = grantableRoles.find((r) => r.key === roleKey) ?? null;
  const needsSubteam = selectedRole?.scope === "subteam";
  // When a subteam role is selected, restrict the subteam picker to subteams the
  // granter can actually grant THAT role into.
  const subteamChoices = useMemo(
    () => (selectedRole && needsSubteam ? subteamsForRole(selectedRole) : grantableSubteams),
    [selectedRole, needsSubteam, subteamsForRole, grantableSubteams],
  );
  const canAdd =
    !!selectedRole &&
    (!needsSubteam || (!!subteamId && grantableInScope(selectedRole, subteamId)));

  function submit() {
    if (!selectedRole) return;
    onGrant(person.user_id, selectedRole.key, needsSubteam ? subteamId : null);
    setAdding(false);
    setRoleKey("");
    setSubteamId("");
  }

  return (
    <tr className="border-b border-helios-line/60 align-top transition-colors last:border-b-0 hover:bg-helios-panel/40 [&>td]:px-3 [&>td]:py-2.5">
      <td>
        <div className="flex items-center gap-2.5">
          <Avatar person={person} />
          {editing ? (
            <div className="flex min-w-0 flex-col gap-1">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Display name"
                aria-label="Display name"
                className="w-44 rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] text-helios-text outline-none focus:border-asu-gold"
              />
              <span className="truncate text-[10px] text-helios-dim">{person.email}</span>
            </div>
          ) : (
            <div className="group/edit flex min-w-0 items-center gap-1.5">
              <div className="min-w-0">
                <div className="truncate text-helios-text">
                  {person.display_name ?? person.email ?? "(unknown)"}
                </div>
                {person.display_name && person.email ? (
                  <div className="truncate text-[10px] text-helios-dim">{person.email}</div>
                ) : null}
              </div>
              {canManagePeople && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Edit ${person.display_name ?? person.email ?? "user"}`}
                  onClick={startEdit}
                  className="rounded p-1 text-helios-dim opacity-0 transition hover:text-asu-gold focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold group-hover/edit:opacity-100 disabled:opacity-40"
                >
                  <IconPencil size={13} strokeWidth={1.5} />
                </button>
              )}
              {canManagePeople && (
                <button
                  type="button"
                  disabled={busy || isMe}
                  aria-label={`Delete ${person.display_name ?? person.email ?? "user"}`}
                  title={deleteTitle}
                  onClick={() => onDelete(person)}
                  className="rounded p-1 text-helios-dim opacity-0 transition hover:text-red-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold group-hover/edit:opacity-100 disabled:opacity-40"
                >
                  <IconTrash size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>
          )}
        </div>
      </td>
      <td className="text-helios-dim">
        {editing ? (
          <div className="flex items-center gap-1">
            <select
              value={editSubteam}
              onChange={(e) => setEditSubteam(e.target.value)}
              aria-label="Subteam"
              className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-1 text-[11px] text-helios-text outline-none focus:border-asu-gold"
            >
              <option value="">— none —</option>
              {subteamOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              aria-label="Save"
              onClick={saveEdit}
              className="rounded bg-asu-gold px-1.5 py-1 text-helios-base hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
            >
              <IconDeviceFloppy size={12} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Cancel edit"
              onClick={() => setEditing(false)}
              className="rounded p-1 text-helios-dim hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              <IconX size={12} strokeWidth={1.5} />
            </button>
          </div>
        ) : (
          person.signup_subteam ?? <span className="text-[#5A5F66]">—</span>
        )}
      </td>
      <td>
        <div className="flex flex-wrap items-center gap-1.5">
          {person.roles.length === 0 ? (
            <span className="text-[11px] text-[#5A5F66]">no access</span>
          ) : (
            person.roles.map((r, i) => {
              const color = r.tag ?? "#9CA3AF";
              return (
                <span
                  key={`${r.role}-${r.subteam_id ?? "org"}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-[10px] font-medium"
                  style={{ backgroundColor: color + "22", color, boxShadow: `inset 0 0 0 1px ${color}33` }}
                  title={r.scope === "subteam" && r.subteam_id ? subteamName.get(r.subteam_id) ?? "" : "org-wide"}
                >
                  <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
                  {r.label}
                  {r.scope === "subteam" && r.subteam_id ? (
                    <span className="opacity-70">· {subteamName.get(r.subteam_id) ?? "?"}</span>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${r.label}`}
                    onClick={() => onRevoke(person.user_id, r.role, r.subteam_id)}
                    className="ml-0.5 rounded-full p-0.5 text-current opacity-60 transition hover:bg-red-500/20 hover:text-red-300 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
                  >
                    <IconX size={11} strokeWidth={2} />
                  </button>
                </span>
              );
            })
          )}
          {adding ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-asu-gold/40 bg-helios-panel py-0.5 pl-1.5 pr-1">
              <select
                aria-label="Role"
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
                className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-0.5 text-[11px] text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                <option value="">role…</option>
                {grantableRoles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
              {needsSubteam && (
                <select
                  aria-label="Subteam"
                  value={subteamId}
                  onChange={(e) => setSubteamId(e.target.value)}
                  className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-0.5 text-[11px] text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
                >
                  <option value="">subteam…</option>
                  {subteamChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                disabled={!canAdd || busy}
                onClick={submit}
                className="rounded-full bg-asu-gold px-2 py-0.5 text-[10px] font-semibold text-helios-base transition hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                aria-label="Cancel"
                className="rounded-full p-0.5 text-helios-dim transition hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                <IconX size={12} strokeWidth={1.5} />
              </button>
            </span>
          ) : (
            (can("org.grant_roles") || can("pm.grant_subteam_roles")) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setAdding(true)}
                aria-label="Add role"
                className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-helios-line px-2 py-0.5 text-[10px] text-helios-dim transition hover:border-asu-gold hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
              >
                <IconPlus size={11} strokeWidth={1.5} />
                role
              </button>
            )
          )}
        </div>
      </td>
    </tr>
  );
}

// --- Org Structure: subteam × project map -----------------------------------

const PROGRAM_OPTS: { v: string; l: string }[] = [
  { v: "", l: "—" },
  { v: "ic", l: "IC" },
  { v: "ev", l: "EV" },
];

/** Colored IC / EV pill so the two car programs read as visually distinct.
 *  IC = warm amber, EV = cool emerald; unset = muted dash. */
function ProgramBadge({ program }: { program: "ic" | "ev" | null | undefined }) {
  if (program === "ic") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300 ring-1 ring-inset ring-amber-500/30">
        <IconEngine size={11} strokeWidth={1.75} aria-hidden />
        IC
      </span>
    );
  }
  if (program === "ev") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
        <IconBolt size={11} strokeWidth={1.75} aria-hidden />
        EV
      </span>
    );
  }
  return <span className="text-[9px] uppercase tracking-wider text-[#5A5F66]">—</span>;
}

function StructurePanel() {
  const { data: projects, refetch: refetchProjects } = useProjects();
  const { data: subteams, refetch: refetchSubteams } = useSubteams();
  const { keys, refetch: refetchMap } = useProjectSubteams();
  const { can } = useMyCapabilities();
  const { setProjectSubteam, setProjectProgram, createSubteam, deleteSubteam } = useOrgMutations();
  const editable = can("org.manage_structure");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newCar, setNewCar] = useState("");

  async function run(fn: () => Promise<{ ok: boolean; error: string | null }>, after: () => void) {
    setBusy(true);
    setErr(null);
    const r = await fn();
    if (!r.ok) setErr(r.error);
    else after();
    setBusy(false);
  }

  return (
    <div className="p-4">
      <SectionHeader
        icon={<IconSitemap size={14} strokeWidth={1.75} />}
        title="Org Structure"
        hint={
          <>
            Tag each car <span className="text-amber-300">IC</span> or <span className="text-emerald-300">EV</span>, map
            which subteams build which car (a subteam in two cars is{" "}
            <span className="text-asu-gold">shared</span>), and add or remove subteams.
            {editable ? "" : " · read-only (needs the Manage-org-structure capability)"}
          </>
        }
      />
      {err && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">
          {err}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-helios-line">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-helios-panel/60 text-[10px] uppercase tracking-wider text-helios-dim">
            <tr className="border-b border-helios-line">
              <th className="px-3 py-2.5 font-medium">Subteam</th>
              {projects.map((p) => (
                <th key={p.id} className="px-3 py-2.5 text-center font-medium">
                  <div className="flex flex-col items-center gap-1.5">
                    <span className="normal-case text-helios-text">{p.name}</span>
                    {editable ? (
                      <select
                        value={p.program ?? ""}
                        disabled={busy}
                        aria-label={`${p.name} program`}
                        onChange={(e) =>
                          run(
                            () => setProjectProgram(p.id, (e.target.value || null) as "ic" | "ev" | null),
                            refetchProjects,
                          )
                        }
                        className={
                          "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                          (p.program === "ic"
                            ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                            : p.program === "ev"
                              ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                              : "border-helios-line bg-helios-base text-helios-dim")
                        }
                      >
                        {PROGRAM_OPTS.map((o) => (
                          <option key={o.v} value={o.v} className="bg-helios-base normal-case text-helios-text">
                            {o.l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <ProgramBadge program={p.program} />
                    )}
                  </div>
                </th>
              ))}
              <th className="px-3 py-2.5 text-center font-medium">Shared</th>
              {editable && <th className="px-3 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {subteams.map((s) => {
              const count = projects.filter((p) => keys.has(`${p.id}:${s.id}`)).length;
              return (
                <tr key={s.id} className="border-b border-helios-line/60 transition-colors last:border-b-0 hover:bg-helios-panel/40">
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-2 text-helios-text">
                      <span aria-hidden className="size-2.5 rounded-full ring-1 ring-inset ring-white/10" style={{ backgroundColor: s.color ?? "#6B7280" }} />
                      {s.name}
                    </span>
                  </td>
                  {projects.map((p) => {
                    const checked = keys.has(`${p.id}:${s.id}`);
                    return (
                      <td key={p.id} className="px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!editable || busy}
                          aria-label={`${s.name} in ${p.name}`}
                          onChange={() => run(() => setProjectSubteam(p.id, s.id, !checked), refetchMap)}
                          className="size-3.5 cursor-pointer accent-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-center">
                    {count >= 2 ? (
                      <span className="rounded-full bg-asu-gold/15 px-2 py-0.5 text-[10px] font-medium text-asu-gold ring-1 ring-inset ring-asu-gold/30">shared</span>
                    ) : (
                      <span className="text-[#5A5F66]">—</span>
                    )}
                  </td>
                  {editable && (
                    <td className="px-3 py-2.5 text-right">
                      {confirmDel === s.id ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(() => deleteSubteam(s.id), () => {
                              setConfirmDel(null);
                              refetchSubteams();
                              refetchMap();
                            })
                          }
                          onBlur={() => setConfirmDel(null)}
                          className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-300 ring-1 ring-inset ring-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
                        >
                          remove?
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Remove ${s.name}`}
                          onClick={() => setConfirmDel(s.id)}
                          className="rounded p-1 text-helios-dim transition hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
                        >
                          <IconTrash size={13} strokeWidth={1.5} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            run(
              () => createSubteam(newName.trim(), newCode.trim(), "", newCar || null),
              () => {
                setNewName("");
                setNewCode("");
                setNewCar("");
                refetchSubteams();
                refetchMap();
              },
            );
          }}
          className="mt-4 rounded-lg border border-helios-line bg-helios-panel p-3"
        >
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
            <IconPlus size={12} strokeWidth={1.75} aria-hidden />
            Add subteam
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-helios-dim">
              Subteam name
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. EV Chassis"
                className="w-44 rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-helios-dim">
              Code
              <input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="auto"
                className="w-20 rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-helios-dim">
              Add to car
              <select
                value={newCar}
                onChange={(e) => setNewCar(e.target.value)}
                className="rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                <option value="">(none yet)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.program ? ` · ${p.program.toUpperCase()}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={busy || !newName.trim()}
              className="inline-flex items-center gap-1 rounded bg-asu-gold px-2.5 py-1.5 text-[11px] font-semibold text-helios-base transition hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
            >
              <IconPlus size={14} strokeWidth={1.5} />
              Add subteam
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// --- Role Editor ------------------------------------------------------------

const BLANK_ROLE: RoleWithCaps = {
  id: "",
  key: "",
  label: "",
  // Lowercase to match <input type="color">, which always reports lowercase
  // hex — otherwise the dirty check below trips the moment the picker mounts.
  tag: "#6b7280",
  scope: "subteam",
  is_system: false,
  sort_order: 100,
  capabilities: [],
};

function RoleEditorPanel() {
  const { data: roles, refetch } = useRolesWithCaps();
  const caps = useCapabilities();
  const { can, refetch: refetchMyCaps } = useMyCapabilities();
  const { upsertRole, deleteRole } = useOrgMutations();
  const canManage = can("org.manage_roles");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Editing a role's capability set can change the current admin's own effective
  // capabilities (if they hold that role), so refresh them alongside the catalog.
  const onSaved = () => {
    refetch();
    refetchMyCaps();
  };

  return (
    <div className="p-4">
      <SectionHeader
        icon={<IconShieldLock size={14} strokeWidth={1.75} />}
        title="Role Editor"
        hint={
          <>
            A role is a set of capabilities. Higher roles aren't special — they just hold more capabilities.
            {canManage ? "" : " · read-only"}
          </>
        }
        right={
          canManage && !creating ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-helios-line px-2.5 py-1 text-xs font-medium text-helios-text transition hover:border-asu-gold hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              <IconUserPlus size={14} strokeWidth={1.5} />
              New role
            </button>
          ) : undefined
        }
      />
      {err && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">
          {err}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {creating && (
          <RoleCard
            role={BLANK_ROLE}
            caps={caps}
            can={can}
            canManage={canManage}
            isNew
            onSaved={() => {
              setCreating(false);
              onSaved();
            }}
            onCancel={() => setCreating(false)}
            onError={setErr}
            upsertRole={upsertRole}
            deleteRole={deleteRole}
          />
        )}
        {(roles ?? []).map((r) => (
          <RoleCard
            key={r.id}
            role={r}
            caps={caps}
            can={can}
            canManage={canManage}
            onSaved={onSaved}
            onError={setErr}
            upsertRole={upsertRole}
            deleteRole={deleteRole}
          />
        ))}
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function RoleCard(props: {
  role: RoleWithCaps;
  caps: Capability[];
  can: (cap: string, subteamId?: string | null) => boolean;
  canManage: boolean;
  isNew?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
  onError: (msg: string | null) => void;
  upsertRole: (key: string, label: string, tag: string, scope: "org" | "subteam", capabilities: string[]) => Promise<{ ok: boolean; error: string | null }>;
  deleteRole: (key: string) => Promise<{ ok: boolean; error: string | null }>;
}) {
  const { role, caps, can, canManage, isNew, onSaved, onCancel, onError, upsertRole, deleteRole } = props;
  // A capability is grantable by this admin iff they hold it themselves (the
  // server enforces the same subset rule in pm.upsert_role). Caps the admin
  // lacks are shown but disabled — they can neither add nor remove them.
  const canGrant = (key: string) => can(key);
  // Caps this role already has that the admin CANNOT grant. The server's subset
  // check would reject an upsert that includes them, so a partial-cap admin must
  // not be able to reshape a role that depends on caps they lack — otherwise
  // every save fails (or, worse, silently strips those caps). Lock such cards.
  const ungrantableExisting = useMemo(
    () => role.capabilities.filter((c) => !canGrant(c)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role.capabilities, can],
  );
  const blockedByCaps = !isNew && ungrantableExisting.length > 0;
  const locked = role.is_system || !canManage || blockedByCaps;
  const [label, setLabel] = useState(role.label);
  const [tag, setTag] = useState((role.tag ?? "#6b7280").toLowerCase());
  const [scope, setScope] = useState<"org" | "subteam">(role.scope);
  const [selected, setSelected] = useState<Set<string>>(new Set(role.capabilities));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty =
    isNew ||
    label !== role.label ||
    // <input type="color"> reports lowercase hex; compare case-insensitively so
    // an unchanged uppercase stored tag doesn't read as a pending edit.
    tag !== (role.tag ?? "#6b7280").toLowerCase() ||
    scope !== role.scope ||
    selected.size !== role.capabilities.length ||
    role.capabilities.some((c) => !selected.has(c));

  function toggleCap(key: string) {
    // Defense in depth: never let a disabled cap mutate the selection, so the
    // saved set can never include a disabled-but-checked cap the admin lacks.
    if (!canGrant(key)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    const key = isNew ? slugify(label) : role.key;
    if (!key) {
      onError("Give the role a name.");
      return;
    }
    // Only send caps the admin can actually grant. This prevents a disabled
    // (un-grantable) cap from being included in the payload and tripping the
    // server's subset check — which previously made every save fail.
    const payloadCaps = grantableCapsPayload(selected, can);
    setBusy(true);
    onError(null);
    const r = await upsertRole(key, label.trim(), tag, scope, payloadCaps);
    if (!r.ok) onError(r.error);
    else onSaved();
    setBusy(false);
  }

  async function remove() {
    setBusy(true);
    onError(null);
    const r = await deleteRole(role.key);
    if (!r.ok) onError(r.error);
    else onSaved();
    setBusy(false);
  }

  const orgCaps = caps.filter((c) => c.scope === "org");
  const subteamCaps = caps.filter((c) => c.scope === "subteam");

  // Surface the FULL grantable catalog: every capability is shown. Caps the
  // admin can grant are enabled; caps they lack are shown disabled with a
  // tooltip explaining why, so an admin can see the complete permission set for
  // a role/subteam and exactly which ones they're allowed to grant.
  const capCheckbox = (c: Capability) => {
    const grantable = canGrant(c.key);
    const reason = !canManage
      ? "You can only view roles."
      : role.is_system
        ? "This role is protected and cannot be edited."
        : !grantable
          ? "You don't hold this capability, so you can't grant or revoke it."
          : (c.description ?? undefined);
    return (
      <label
        key={c.key}
        className={
          "flex items-start gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors " +
          (locked || !grantable ? "text-helios-dim" : "text-helios-text hover:bg-helios-base/60")
        }
        title={reason}
      >
        <input
          type="checkbox"
          checked={selected.has(c.key)}
          disabled={locked || busy || !grantable}
          onChange={() => toggleCap(c.key)}
          className="mt-0.5 size-3 cursor-pointer accent-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
        />
        <span>{c.label}</span>
        {!grantable && canManage && !role.is_system ? (
          <span
            aria-hidden
            className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-[#5A5F66]"
            title="You don't hold this capability"
          >
            locked
          </span>
        ) : null}
      </label>
    );
  };

  return (
    <section className="relative overflow-hidden rounded-lg border border-helios-line bg-helios-panel p-3 pl-4">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: tag }} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span aria-hidden className="size-3 shrink-0 rounded-full ring-2 ring-inset ring-white/10" style={{ backgroundColor: tag }} />
        {locked ? (
          <span className="text-sm font-semibold text-helios-text">{role.label}</span>
        ) : (
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Role name"
            aria-label="Role name"
            className="rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm font-medium text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
          />
        )}
        {!locked && (
          <>
            <input
              type="color"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              aria-label="Tag color"
              className="h-6 w-8 cursor-pointer rounded border border-helios-line bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "org" | "subteam")}
              aria-label="Scope"
              className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-1 text-[11px] text-helios-text outline-none focus:border-asu-gold focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              <option value="subteam">per subteam</option>
              <option value="org">org-wide</option>
            </select>
          </>
        )}
        {locked && (
          <span
            className={
              "rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
              (role.scope === "org"
                ? "bg-asu-gold/15 text-asu-gold ring-1 ring-inset ring-asu-gold/30"
                : "bg-helios-base text-helios-dim ring-1 ring-inset ring-helios-line")
            }
          >
            {role.scope === "org" ? "org-wide" : "per subteam"}
          </span>
        )}
        {role.is_system && (
          <span className="rounded-full bg-helios-base px-2 py-0.5 text-[10px] uppercase tracking-wider text-helios-dim ring-1 ring-inset ring-helios-line">
            protected
          </span>
        )}
        <span className="ml-auto inline-flex items-center rounded-full bg-helios-base px-2 py-0.5 text-[10px] tabular-nums text-helios-dim">
          {selected.size} {selected.size === 1 ? "capability" : "capabilities"}
        </span>
      </div>

      {blockedByCaps && (
        <div className="mb-3 rounded-md border border-helios-line bg-helios-base/60 px-2.5 py-1.5 text-[10px] leading-relaxed text-helios-dim">
          This role includes {ungrantableExisting.length}{" "}
          {ungrantableExisting.length === 1 ? "capability" : "capabilities"} you don't hold, so you can't
          edit it. An admin with those capabilities must make changes.
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-helios-dim">Org-wide</div>
          <div className="flex flex-col">
            {orgCaps.length === 0 ? (
              <span className="px-1.5 py-1 text-[11px] text-[#5A5F66]">None.</span>
            ) : (
              orgCaps.map(capCheckbox)
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-helios-dim">Per-subteam</div>
          <div className="flex flex-col">
            {subteamCaps.length === 0 ? (
              <span className="px-1.5 py-1 text-[11px] text-[#5A5F66]">None.</span>
            ) : (
              subteamCaps.map(capCheckbox)
            )}
          </div>
        </div>
      </div>

      {!locked && (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-helios-line/60 pt-3">
          {!isNew && (
            confirmDelete ? (
              <button
                type="button"
                onClick={remove}
                onBlur={() => setConfirmDelete(false)}
                disabled={busy}
                className="rounded bg-red-500/15 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-red-300 ring-1 ring-inset ring-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
              >
                Delete role?
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-helios-line px-2 py-1 text-[11px] text-helios-dim transition hover:border-red-500/50 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
              >
                <IconTrash size={13} strokeWidth={1.5} />
                Delete
              </button>
            )
          )}
          {isNew && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-helios-line px-2 py-1 text-[11px] text-helios-dim transition hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="inline-flex items-center gap-1 rounded bg-asu-gold px-2.5 py-1 text-[11px] font-semibold text-helios-base transition hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
          >
            <IconDeviceFloppy size={13} strokeWidth={1.5} />
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      )}
    </section>
  );
}
