import { useEffect, useMemo, useState } from "react";
import { IconDeviceFloppy, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useSupabaseClient } from "@helios/auth";
import {
  useCapabilities,
  useMyCapabilities,
  usePeople,
  useProjects,
  useProjectSubteams,
  useRoles,
  useRolesWithCaps,
  useSubteams,
  type Capability,
  type OrgRole,
  type Person,
  type RoleWithCaps,
} from "./data/useOrgData";
import { useOrgMutations } from "./data/useOrgMutations";

type Tab = "people" | "structure" | "roles";

const TABS: { id: Tab; label: string }[] = [
  { id: "people", label: "People & Roles" },
  { id: "structure", label: "Org Structure" },
  { id: "roles", label: "Role Editor" },
];

export function OrgModule() {
  const [tab, setTab] = useState<Tab>("people");
  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      <header className="flex flex-shrink-0 flex-col gap-2 border-b border-helios-line px-5 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-asu-gold">Admin</div>
          <p className="mt-0.5 text-[11px] text-helios-dim">
            People, roles, and the subteam ↔ project map — shared across Vault and PM.
          </p>
        </div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={
                "rounded px-3 py-1.5 text-xs font-medium transition-colors " +
                (tab === t.id
                  ? "bg-asu-gold/15 text-asu-gold"
                  : "text-helios-dim hover:bg-helios-panel hover:text-helios-text")
              }
            >
              {t.label}
            </button>
          ))}
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

interface Subteam {
  id: string;
  name: string;
  code: string;
}

function PeopleRolesPanel() {
  const client = useSupabaseClient();
  const { data: people, loading, error, refetch } = usePeople();
  const { data: roles } = useRoles();
  const { can } = useMyCapabilities();
  const { grantRole, revokeRole } = useOrgMutations();

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

  const subteamName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of subteams) m.set(s.id, s.name);
    return m;
  }, [subteams]);

  async function doGrant(target: string, roleKey: string, subteamId: string | null) {
    setBusyUser(target);
    setActionError(null);
    const r = await grantRole(target, roleKey, subteamId);
    if (!r.ok) setActionError(r.error);
    else refetch();
    setBusyUser(null);
  }
  async function doRevoke(target: string, roleKey: string, subteamId: string | null) {
    setBusyUser(target);
    setActionError(null);
    const r = await revokeRole(target, roleKey, subteamId);
    if (!r.ok) setActionError(r.error);
    else refetch();
    setBusyUser(null);
  }

  return (
    <div className="p-4">
      {actionError && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert">
          {actionError}
        </div>
      )}
      {error ? (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-[12px] text-red-200">
          {error.message}
        </div>
      ) : loading ? (
        <div className="p-6 text-sm text-helios-dim">Loading people…</div>
      ) : (
        <table className="w-full text-left text-[12px]">
          <thead className="sticky top-0 bg-helios-base text-[10px] uppercase tracking-wider text-helios-dim">
            <tr className="border-b border-helios-line [&>th]:px-3 [&>th]:py-2 [&>th]:font-normal">
              <th className="w-[24%]">User</th>
              <th className="w-[14%]">Signup subteam</th>
              <th>Roles</th>
            </tr>
          </thead>
          <tbody>
            {(people ?? []).map((p) => (
              <PersonRow
                key={p.user_id}
                person={p}
                roles={roles ?? []}
                subteams={subteams}
                subteamName={subteamName}
                busy={busyUser === p.user_id}
                can={can}
                onGrant={doGrant}
                onRevoke={doRevoke}
              />
            ))}
            {(people ?? []).length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-[11px] text-helios-dim">
                  No accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PersonRow(props: {
  person: Person;
  roles: OrgRole[];
  subteams: Subteam[];
  subteamName: Map<string, string>;
  busy: boolean;
  can: (cap: string, subteamId?: string | null) => boolean;
  onGrant: (target: string, roleKey: string, subteamId: string | null) => void;
  onRevoke: (target: string, roleKey: string, subteamId: string | null) => void;
}) {
  const { person, roles, subteams, subteamName, busy, can, onGrant, onRevoke } = props;
  const [adding, setAdding] = useState(false);
  const [roleKey, setRoleKey] = useState("");
  const [subteamId, setSubteamId] = useState("");

  const selectedRole = roles.find((r) => r.key === roleKey) ?? null;
  const needsSubteam = selectedRole?.scope === "subteam";
  const canAdd = !!selectedRole && (!needsSubteam || !!subteamId);

  function submit() {
    if (!selectedRole) return;
    onGrant(person.user_id, selectedRole.key, needsSubteam ? subteamId : null);
    setAdding(false);
    setRoleKey("");
    setSubteamId("");
  }

  return (
    <tr className="border-b border-helios-line/60 align-top [&>td]:px-3 [&>td]:py-2">
      <td>
        <div className="text-helios-text">{person.display_name ?? person.email ?? "(unknown)"}</div>
        {person.display_name && person.email ? (
          <div className="text-[10px] text-helios-dim">{person.email}</div>
        ) : null}
      </td>
      <td className="text-helios-dim">{person.signup_subteam ?? "—"}</td>
      <td>
        <div className="flex flex-wrap items-center gap-1.5">
          {person.roles.length === 0 ? (
            <span className="text-[11px] text-[#5A5F66]">no access</span>
          ) : (
            person.roles.map((r, i) => (
              <span
                key={`${r.role}-${r.subteam_id ?? "org"}-${i}`}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
                style={{ borderColor: (r.tag ?? "#6B7280") + "66", color: r.tag ?? "#D8DCE2" }}
                title={r.scope === "subteam" && r.subteam_id ? subteamName.get(r.subteam_id) ?? "" : "org-wide"}
              >
                {r.label}
                {r.scope === "subteam" && r.subteam_id ? (
                  <span className="text-helios-dim">· {subteamName.get(r.subteam_id) ?? "?"}</span>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${r.label}`}
                  onClick={() => onRevoke(person.user_id, r.role, r.subteam_id)}
                  className="text-helios-dim hover:text-red-300 disabled:opacity-40"
                >
                  <IconX size={11} strokeWidth={2} />
                </button>
              </span>
            ))
          )}
          {adding ? (
            <span className="inline-flex items-center gap-1">
              <select
                aria-label="Role"
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
                className="rounded-sm border border-helios-line bg-helios-panel px-1.5 py-0.5 text-[11px] text-helios-text outline-none focus:border-asu-gold"
              >
                <option value="">role…</option>
                {roles.map((r) => (
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
                  className="rounded-sm border border-helios-line bg-helios-panel px-1.5 py-0.5 text-[11px] text-helios-text outline-none focus:border-asu-gold"
                >
                  <option value="">subteam…</option>
                  {subteams.map((s) => (
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
                className="rounded-sm bg-asu-gold px-1.5 py-0.5 text-[10px] font-semibold text-helios-base hover:bg-asu-gold/90 disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                aria-label="Cancel"
                className="text-helios-dim hover:text-helios-text"
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
                className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-helios-line px-1.5 py-0.5 text-[10px] text-helios-dim hover:border-asu-gold hover:text-asu-gold disabled:opacity-40"
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
      <p className="mb-3 text-[11px] text-helios-dim">
        Tag each car <span className="text-helios-text">IC</span> or <span className="text-helios-text">EV</span>, map
        which subteams build which car (a subteam in two cars is <span className="text-helios-text">shared</span>), and
        add or remove subteams.
        {editable ? "" : " · read-only (needs the Manage-org-structure capability)"}
      </p>
      {err && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          {err}
        </div>
      )}
      <table className="text-left text-[12px]">
        <thead className="text-[10px] uppercase tracking-wider text-helios-dim">
          <tr className="border-b border-helios-line">
            <th className="px-3 py-2 font-normal">Subteam</th>
            {projects.map((p) => (
              <th key={p.id} className="px-3 py-2 text-center font-normal">
                <div className="flex flex-col items-center gap-1">
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
                      className="rounded-sm border border-helios-line bg-helios-base px-1 py-0.5 text-[10px] text-helios-text"
                    >
                      {PROGRAM_OPTS.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className={
                        "rounded-full px-1.5 text-[9px] " +
                        (p.program ? "bg-asu-gold/15 text-asu-gold" : "text-[#5A5F66]")
                      }
                    >
                      {p.program ? p.program.toUpperCase() : "—"}
                    </span>
                  )}
                </div>
              </th>
            ))}
            <th className="px-3 py-2 text-center font-normal">Shared</th>
            {editable && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {subteams.map((s) => {
            const count = projects.filter((p) => keys.has(`${p.id}:${s.id}`)).length;
            return (
              <tr key={s.id} className="border-b border-helios-line/60">
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-helios-text">
                    <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: s.color ?? "#6B7280" }} />
                    {s.name}
                  </span>
                </td>
                {projects.map((p) => {
                  const checked = keys.has(`${p.id}:${s.id}`);
                  return (
                    <td key={p.id} className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!editable || busy}
                        aria-label={`${s.name} in ${p.name}`}
                        onChange={() => run(() => setProjectSubteam(p.id, s.id, !checked), refetchMap)}
                        className="size-3.5 accent-asu-gold disabled:opacity-40"
                      />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-center">
                  {count >= 2 ? (
                    <span className="rounded-full bg-asu-gold/15 px-2 py-0.5 text-[10px] text-asu-gold">shared</span>
                  ) : (
                    <span className="text-[#5A5F66]">—</span>
                  )}
                </td>
                {editable && (
                  <td className="px-3 py-2 text-right">
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
                        className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-300"
                      >
                        remove?
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${s.name}`}
                        onClick={() => setConfirmDel(s.id)}
                        className="rounded p-1 text-helios-dim hover:text-red-300"
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
          className="mt-4 flex flex-wrap items-end gap-2 border-t border-helios-line pt-3"
        >
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-helios-dim">
            Subteam name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. EV Chassis"
              className="w-44 rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-helios-dim">
            Code
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="auto"
              className="w-20 rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-helios-dim">
            Add to car
            <select
              value={newCar}
              onChange={(e) => setNewCar(e.target.value)}
              className="rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] normal-case tracking-normal text-helios-text outline-none focus:border-asu-gold"
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
            className="inline-flex items-center gap-1 rounded bg-asu-gold px-2.5 py-1.5 text-[11px] font-semibold text-helios-base hover:bg-asu-gold/90 disabled:opacity-40"
          >
            <IconPlus size={14} strokeWidth={1.5} />
            Add subteam
          </button>
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
  tag: "#6B7280",
  scope: "subteam",
  is_system: false,
  sort_order: 100,
  capabilities: [],
};

function RoleEditorPanel() {
  const { data: roles, refetch } = useRolesWithCaps();
  const caps = useCapabilities();
  const { can } = useMyCapabilities();
  const { upsertRole, deleteRole } = useOrgMutations();
  const canManage = can("org.manage_roles");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-helios-dim">
          A role is a set of capabilities. Higher roles aren't special — they just hold more capabilities.
          {canManage ? "" : " · read-only"}
        </p>
        {canManage && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-helios-line px-2.5 py-1 text-xs text-helios-text hover:border-asu-gold hover:text-asu-gold"
          >
            <IconPlus size={14} strokeWidth={1.5} />
            New role
          </button>
        )}
      </div>
      {err && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
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
              refetch();
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
            onSaved={refetch}
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
  const locked = role.is_system || !canManage;
  const [label, setLabel] = useState(role.label);
  const [tag, setTag] = useState(role.tag ?? "#6B7280");
  const [scope, setScope] = useState<"org" | "subteam">(role.scope);
  const [selected, setSelected] = useState<Set<string>>(new Set(role.capabilities));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty =
    isNew ||
    label !== role.label ||
    tag !== (role.tag ?? "#6B7280") ||
    scope !== role.scope ||
    selected.size !== role.capabilities.length ||
    role.capabilities.some((c) => !selected.has(c));

  function toggleCap(key: string) {
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
    setBusy(true);
    onError(null);
    const r = await upsertRole(key, label.trim(), tag, scope, [...selected]);
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

  return (
    <section className="rounded-lg border border-helios-line bg-helios-panel p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ backgroundColor: tag }} />
        {locked ? (
          <span className="text-sm font-medium text-helios-text">{role.label}</span>
        ) : (
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Role name"
            aria-label="Role name"
            className="rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm text-helios-text outline-none focus:border-asu-gold"
          />
        )}
        {!locked && (
          <>
            <input
              type="color"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              aria-label="Tag color"
              className="h-6 w-8 cursor-pointer rounded border border-helios-line bg-transparent"
            />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "org" | "subteam")}
              aria-label="Scope"
              className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-1 text-[11px] text-helios-text outline-none focus:border-asu-gold"
            >
              <option value="subteam">per subteam</option>
              <option value="org">org-wide</option>
            </select>
          </>
        )}
        {role.is_system && (
          <span className="rounded-full bg-helios-base px-2 py-0.5 text-[10px] uppercase tracking-wider text-helios-dim">
            protected
          </span>
        )}
        <span className="ml-auto text-[10px] text-helios-dim">{selected.size} capabilities</span>
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {[...orgCaps, ...subteamCaps].map((c) => (
          <label
            key={c.key}
            className={"flex items-start gap-1.5 text-[11px] " + (locked ? "text-helios-dim" : "text-helios-text")}
            title={c.description ?? undefined}
          >
            <input
              type="checkbox"
              checked={selected.has(c.key)}
              disabled={locked || busy || !can(c.key)}
              onChange={() => toggleCap(c.key)}
              className="mt-0.5 size-3 accent-asu-gold disabled:opacity-40"
            />
            <span>
              {c.label}
              <span className="ml-1 text-[9px] uppercase tracking-wider text-[#5A5F66]">{c.scope}</span>
            </span>
          </label>
        ))}
      </div>

      {!locked && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {!isNew && (
            confirmDelete ? (
              <button
                type="button"
                onClick={remove}
                onBlur={() => setConfirmDelete(false)}
                disabled={busy}
                className="rounded bg-red-500/15 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-red-300"
              >
                Delete role?
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-helios-line px-2 py-1 text-[11px] text-helios-dim hover:border-red-500/50 hover:text-red-300"
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
              className="rounded border border-helios-line px-2 py-1 text-[11px] text-helios-dim hover:text-helios-text"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="inline-flex items-center gap-1 rounded bg-asu-gold px-2.5 py-1 text-[11px] font-semibold text-helios-base hover:bg-asu-gold/90 disabled:opacity-40"
          >
            <IconDeviceFloppy size={13} strokeWidth={1.5} />
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      )}
    </section>
  );
}
