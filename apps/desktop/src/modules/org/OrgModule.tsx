import { useEffect, useMemo, useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useSupabaseClient } from "@helios/auth";
import { useMyCapabilities, usePeople, useRoles, type OrgRole, type Person } from "./data/useOrgData";
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
        {tab === "people" ? (
          <PeopleRolesPanel />
        ) : (
          <Placeholder
            title={tab === "structure" ? "Org Structure" : "Role Editor"}
            note={
              tab === "structure"
                ? "Map subteams to projects (EV / IC / shared) — coming in the next update."
                : "Create and edit roles + their capabilities — coming in the next update."
            }
          />
        )}
      </div>
    </div>
  );
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="p-8 text-center">
      <div className="text-sm font-medium text-helios-text">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-xs text-helios-dim">{note}</p>
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
