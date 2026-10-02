import { useState } from "react";
import { STATUSES, STATUS_LABEL, type Priority, type Status } from "../lib/api";
import { GROUP_LABEL, SORT_LABEL, describeView, type GroupBy, type SavedView, type SortBy, type ViewConfig } from "../lib/views";
import { Button } from "./ui";

const box = "rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm";

/** The row of views above Abacus, as in Airtable: click one to switch, the pencil to change it. */
export function ViewBar({ views, active, onPick, onNew, onEdit, canEdit }: {
  views: SavedView[]; active: string;
  onPick: (id: string) => void; onNew: () => void; onEdit: (v: SavedView) => void;
  canEdit: (v: SavedView) => boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Views">
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-helios-dim">Views</span>
      {views.map((v) => {
        const on = v.id === active;
        return (
          <span key={v.id} className={`group inline-flex items-center rounded-full border text-xs ${on ? "border-asu-gold bg-asu-gold/10 text-asu-gold" : "border-helios-line text-helios-dim hover:bg-helios-strip"}`}>
            <button role="tab" aria-selected={on} aria-label={v.name} className="px-3 py-1" onClick={() => onPick(v.id)}
              title={`${describeView(v.config)}${v.owner_name ? ` | made by ${v.owner_name}` : ""}${v.shared ? "" : " | only you see it"}`}>
              {v.name}{!v.shared && <span className="ml-1 text-[10px] opacity-70">(you)</span>}
            </button>
            {canEdit(v) && (
              <button className={`-ml-1 pr-2 ${on ? "" : "hidden group-hover:inline"}`} title="Change this view" aria-label={`Change view ${v.name}`} onClick={() => onEdit(v)}>&#9998;</button>
            )}
          </span>
        );
      })}
      <button className="rounded-full border border-dashed border-helios-line px-3 py-1 text-xs text-helios-dim hover:bg-helios-strip" onClick={onNew}>+ New view</button>
    </div>
  );
}

/** Make or change a view: what shows, grouping, sorting, columns, and who sees it. */
export function ViewEditor({ initial, columns, onSave, onDelete, onCancel }: {
  initial: { id: string | null; name: string; config: ViewConfig; shared: boolean };
  columns: { key: string; label: string }[];
  onSave: (v: { id: string | null; name: string; config: ViewConfig; shared: boolean }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [c, setC] = useState<ViewConfig>(initial.config);
  const [shared, setShared] = useState(initial.shared);
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(xs: T[] | undefined, x: T, on: boolean): T[] => (on ? [...(xs ?? []), x] : (xs ?? []).filter((y) => y !== x));
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label="View">
      <form className="flex max-h-[calc(100vh-3rem)] w-[min(640px,94vw)] flex-col gap-4 overflow-auto rounded-xl border border-helios-line bg-helios-panel p-5 shadow-2xl"
        onSubmit={(e) => { e.preventDefault(); void run(() => onSave({ id: initial.id, name, config: c, shared })); }}>
        <div>
          <h2 className="text-base font-semibold">{initial.id ? "Change view" : "New view"}</h2>
          <p className="text-xs text-helios-dim">A view only changes what Abacus shows, never the parts. It applies to whichever car and subteam tab is open.</p>
        </div>
        <label className="flex flex-col gap-1 text-sm">Name
          <input autoFocus className={box} value={name} maxLength={60} placeholder="e.g. Brakes to order this week" onChange={(e) => setName(e.target.value)} />
        </label>

        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 font-semibold">Show parts that are</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {STATUSES.map((s: Status) => (
              <label key={s} className="flex items-center gap-1"><input type="checkbox" checked={!!c.statuses?.includes(s)}
                onChange={(e) => setC({ ...c, statuses: toggle(c.statuses, s, e.target.checked) })} />{STATUS_LABEL[s]}</label>
            ))}
          </div>
          <span className="text-xs text-helios-dim">None ticked = every status.</span>
        </fieldset>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-3">Priority
            {(["HIGH", "Medium", "Low"] as Priority[]).map((p) => (
              <label key={p} className="flex items-center gap-1"><input type="checkbox" checked={!!c.priorities?.includes(p)}
                onChange={(e) => setC({ ...c, priorities: toggle(c.priorities, p, e.target.checked) })} />{p === "HIGH" ? "High" : p}</label>
            ))}
          </span>
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.mine} onChange={(e) => setC({ ...c, mine: e.target.checked })} />Only parts I asked for</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.missing} onChange={(e) => setC({ ...c, missing: e.target.checked })} />Only parts missing a price, vendor or link</label>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">Group by
            <select className={box} value={c.groupBy ?? "none"} onChange={(e) => setC({ ...c, groupBy: e.target.value as GroupBy })}>
              {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">Sort by
            <select className={box} value={c.sortBy ?? "sheet"} onChange={(e) => setC({ ...c, sortBy: e.target.value as SortBy })}>
              {(Object.keys(SORT_LABEL) as SortBy[]).map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
            </select>
          </label>
        </div>

        <fieldset className="text-sm">
          <legend className="mb-1 font-semibold">Columns</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {columns.map((col) => (
              <label key={col.key} className="flex items-center gap-1"><input type="checkbox" checked={!c.hidden?.includes(col.key)} disabled={col.key === "title"}
                onChange={(e) => setC({ ...c, hidden: toggle(c.hidden, col.key, !e.target.checked) })} />{col.label}</label>
            ))}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Share with the team (otherwise only you see it)</label>

        <div className="flex items-center justify-between gap-2">
          <div>{onDelete && <Button kind="danger" disabled={busy} onClick={() => void run(onDelete)}>Delete view</Button>}</div>
          <div className="flex gap-2">
            <Button kind="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving..." : "Save view"}</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
