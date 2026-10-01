import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  deleteBudgetLine, fetchBudgetLines, fetchSeasons, setCarSubteam, upsertBudgetLine, upsertSeason, type BudgetLine, type Season,
} from "../lib/api";
import { centsToInput, fmtCents, parseCents } from "../lib/money";
import type { PurchasingData } from "../lib/usePurchasing";
import { Button, Card, useConfirm } from "../components/ui";

const input = "rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm";

interface Draft { id: string | null; project_id: string; name: string; amount: string; subteam_ids: string[] }

/**
 * Execs: seasons and the budget lines in each. A budget line is one car's
 * money for one or more subteams (an Aero line can cover Aero Design and Aero
 * Manufacturing); each subteam counts toward one line per car and season.
 */
export function BudgetSetup({ client, data, reload, flash, done }: {
  client: SupabaseClient; data: PurchasingData; reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void; done: () => void;
}) {
  const { projects, subteams } = data;
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [newSeason, setNewSeason] = useState<{ name: string; starts_on: string; ends_on: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({ id: null, project_id: "", name: "", amount: "", subteam_ids: [] });
  const [ask, confirmDialog] = useConfirm();

  const load = useCallback(async (pick?: string) => {
    try {
      const s = await fetchSeasons(client);
      setSeasons(s);
      const id = pick ?? seasonId ?? s.find((x) => x.is_current)?.id ?? s[0]?.id ?? null;
      setSeasonId(id);
      setLines(id ? await fetchBudgetLines(client, id) : []);
      if (!s.length) setNewSeason((n) => n ?? { name: seasonName(), starts_on: "", ends_on: "" });
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }, [client, seasonId, flash]);
  // load once; later loads pick their season explicitly
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  async function act(label: string, fn: () => Promise<unknown>, pick?: string): Promise<boolean> {
    try { await fn(); await load(pick); await reload(); if (label) flash(label); return true; }
    catch (e) { flash(e instanceof Error ? e.message : String(e), true); return false; }
  }

  const season = seasons.find((s) => s.id === seasonId) ?? null;
  const taken = (projectId: string, exceptLine: string | null) =>
    new Set(lines.filter((l) => l.project_id === projectId && l.id !== exceptLine).flatMap((l) => l.budget_line_subteams.map((x) => x.subteam_id)));

  async function saveLine(d: Draft) {
    if (!seasonId) { flash("Create a season first.", true); return false; }
    if (!d.project_id) { flash("Pick the car.", true); return false; }
    if (!d.name.trim()) { flash("Name the budget line.", true); return false; }
    const cents = parseCents(d.amount);
    if (cents === null || cents < 0) { flash(`"${d.amount}" isn't an amount.`, true); return false; }
    if (!d.subteam_ids.length) { flash("Pick at least one subteam whose spending counts toward it.", true); return false; }
    return act(d.id ? "Budget line saved." : `Added ${d.name.trim()}.`, () =>
      upsertBudgetLine(client, { id: d.id, season_id: seasonId, project_id: d.project_id, name: d.name.trim(), amount_cents: cents, subteam_ids: d.subteam_ids }));
  }

  const total = lines.reduce((s, l) => s + l.amount_cents, 0);

  return (
    <Card className="flex flex-col gap-4 border-asu-gold/60">
      {confirmDialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <b>Set up budgets</b>
          <p className="text-xs text-helios-dim">Execs only. Members see their own subteam's line; execs see all of them.</p>
        </div>
        <Button kind="ghost" onClick={done}>Done</Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-helios-dim">Season
          <select className={input} value={seasonId ?? ""} onChange={(e) => void load(e.target.value)}>
            {!seasons.length && <option value="">(none yet)</option>}
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
          </select>
        </label>
        {season && !season.is_current && (
          <Button kind="ghost" onClick={() => void act(`${season.name} is now the current season.`, () =>
            upsertSeason(client, { ...season, is_current: true }), season.id)}>Make current</Button>
        )}
        {season && (
          <>
            <label className="flex flex-col gap-1 text-xs text-helios-dim">Starts
              <input type="date" className={input} defaultValue={season.starts_on ?? ""} key={`s${season.id}`}
                onBlur={(e) => { if ((e.target.value || null) !== season.starts_on) void act("Saved.", () => upsertSeason(client, { ...season, starts_on: e.target.value || null }), season.id); }} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-helios-dim">Ends
              <input type="date" className={input} defaultValue={season.ends_on ?? ""} key={`e${season.id}`}
                onBlur={(e) => { if ((e.target.value || null) !== season.ends_on) void act("Saved.", () => upsertSeason(client, { ...season, ends_on: e.target.value || null }), season.id); }} />
            </label>
          </>
        )}
        {!newSeason && <Button kind="ghost" onClick={() => setNewSeason({ name: seasonName(), starts_on: "", ends_on: "" })}>+ New season</Button>}
      </div>
      {season && !season.starts_on && (
        <p className="-mt-2 text-xs text-asu-gold">{season.name} has no start date, so every charge in the ledger (last season's too) counts toward its budgets. Set when it started.</p>
      )}

      {newSeason && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-helios-line p-3">
          <label className="flex flex-col gap-1 text-xs text-helios-dim">Name<input className={`${input} w-28`} value={newSeason.name} onChange={(e) => setNewSeason({ ...newSeason, name: e.target.value })} /></label>
          <label className="flex flex-col gap-1 text-xs text-helios-dim">Starts (after competition)<input type="date" className={input} value={newSeason.starts_on} onChange={(e) => setNewSeason({ ...newSeason, starts_on: e.target.value })} /></label>
          <label className="flex flex-col gap-1 text-xs text-helios-dim">Ends<input type="date" className={input} value={newSeason.ends_on} onChange={(e) => setNewSeason({ ...newSeason, ends_on: e.target.value })} /></label>
          <Button disabled={!newSeason.starts_on} onClick={() => void (async () => {
            let id = "";
            const ok = await act(`Season ${newSeason.name} created and made current.`, async () => {
              id = await upsertSeason(client, { id: null, name: newSeason.name, starts_on: newSeason.starts_on || null, ends_on: newSeason.ends_on || null, is_current: true });
            });
            if (ok) { setNewSeason(null); await load(id); }
          })()}>Create</Button>
          {seasons.length > 0 && <Button kind="ghost" onClick={() => setNewSeason(null)}>Cancel</Button>}
          <p className="w-full text-xs text-helios-dim">The new season becomes the current one: new parts and the Budgets page use it. Its start date decides which charges count toward its budgets.</p>
        </div>
      )}

      {season && (
        <div className="overflow-auto rounded-lg border border-helios-line">
          <table className="w-full text-[13px]">
            <thead className="bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
              <tr><th className="p-2 text-left">Car</th><th className="p-2 text-left">Budget line</th><th className="p-2 text-right">Amount</th><th className="p-2 text-left">Subteams it covers</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {[...lines].sort((a, b) => carCode(a.project_id).localeCompare(carCode(b.project_id)) || b.amount_cents - a.amount_cents).map((l) => (
                <LineRow key={l.id} line={l} {...{ projects, subteams }} taken={taken(l.project_id, l.id)}
                  save={saveLine} remove={() => void ask({ title: `Delete the ${carCode(l.project_id)} ${l.name} budget line?`,
                    body: "Its parts and charges stay; they just won't count toward a budget line until one covers their subteam.", confirmLabel: "Delete", danger: true })
                    .then((ok) => ok && act("Budget line deleted.", () => deleteBudgetLine(client, l.id)))} />
              ))}
              <tr className="border-t border-helios-line bg-asu-gold/[0.04]">
                <td className="p-2 align-top">
                  <select className={input} value={draft.project_id} onChange={(e) => setDraft({ ...draft, project_id: e.target.value, subteam_ids: [] })}>
                    <option value="">Car...</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.car_code}</option>)}
                  </select>
                </td>
                <td className="p-2 align-top"><input className={`${input} w-44`} placeholder="e.g. Aero" value={draft.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    // naming a line after a subteam picks that subteam
                    const st = subteams.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
                    setDraft({ ...draft, name, subteam_ids: draft.subteam_ids.length || !st || (draft.project_id && taken(draft.project_id, null).has(st.id)) ? draft.subteam_ids : [st.id] });
                  }} /></td>
                <td className="p-2 align-top"><input className={`${input} w-28 text-right`} placeholder="$0.00" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></td>
                <td className="p-2 align-top">
                  <SubteamPicker subteams={subteams} value={draft.subteam_ids} taken={draft.project_id ? taken(draft.project_id, null) : new Set()}
                    onChange={(ids) => setDraft({ ...draft, subteam_ids: ids })} />
                </td>
                <td className="p-2 align-top"><Button onClick={() => void saveLine(draft).then((ok) => ok && setDraft({ id: null, project_id: draft.project_id, name: "", amount: "", subteam_ids: [] }))}>Add</Button></td>
              </tr>
            </tbody>
          </table>
          <div className="border-t border-helios-line px-3 py-2 text-right text-xs text-helios-dim">{lines.length} lines | <b className="text-helios-text">{fmtCents(total)}</b> budgeted in {season.name}</div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div>
          <b className="text-sm">Subteams on each car</b>
          <p className="text-xs text-helios-dim">The tabs Abacus shows for each car, and where members can add parts. A budget line or a part adds its subteam here by itself.</p>
        </div>
        {projects.map((p) => {
          const mine = data.carSubteams.filter((x) => x.project_id === p.id).map((x) => x.subteam_id);
          return (
            <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-20 font-semibold">{p.car_code}</span>
              <SubteamPicker subteams={subteams} value={mine} taken={new Set()}
                onChange={(ids) => {
                  const added = ids.find((id) => !mine.includes(id));
                  const removed = mine.find((id) => !ids.includes(id));
                  const id = added ?? removed;
                  if (id) void act(added ? "Subteam added." : "Subteam taken off this car (its parts stay).", () => setCarSubteam(client, p.id, id, !!added));
                }} />
            </div>
          );
        })}
      </div>
    </Card>
  );

  function carCode(id: string) { return projects.find((p) => p.id === id)?.car_code ?? "?"; }
}

function LineRow({ line, projects, subteams, taken, save, remove }: {
  line: BudgetLine; projects: PurchasingData["projects"]; subteams: PurchasingData["subteams"]; taken: Set<string>;
  save: (d: Draft) => Promise<boolean>; remove: () => void;
}) {
  const initial: Draft = { id: line.id, project_id: line.project_id, name: line.name, amount: centsToInput(line.amount_cents), subteam_ids: line.budget_line_subteams.map((x) => x.subteam_id) };
  const [d, setD] = useState(initial);
  const changed = JSON.stringify(d) !== JSON.stringify(initial);
  return (
    <tr className="border-t border-helios-line">
      <td className="p-2 align-top">{projects.find((p) => p.id === line.project_id)?.car_code}</td>
      <td className="p-2 align-top"><input className={`${input} w-44 font-semibold`} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></td>
      <td className="p-2 align-top"><input className={`${input} w-28 text-right`} value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} /></td>
      <td className="p-2 align-top"><SubteamPicker subteams={subteams} value={d.subteam_ids} taken={taken} onChange={(ids) => setD({ ...d, subteam_ids: ids })} /></td>
      <td className="whitespace-nowrap p-2 align-top">
        {changed && <Button onClick={() => void save(d)}>Save</Button>}
        {changed && <Button kind="ghost" onClick={() => setD(initial)}>Undo</Button>}
        {!changed && <Button kind="ghost" onClick={remove}>Delete</Button>}
      </td>
    </tr>
  );
}

/** The subteams on a line as chips (click to remove), plus a list to add one. A subteam already on another line for this car can't be added. */
function SubteamPicker({ subteams, value, taken, onChange }: {
  subteams: PurchasingData["subteams"]; value: string[]; taken: Set<string>; onChange: (ids: string[]) => void;
}) {
  const free = subteams.filter((s) => !value.includes(s.id) && !taken.has(s.id));
  return (
    <div className="flex max-w-xl flex-wrap items-center gap-1">
      {value.map((id) => (
        <button key={id} type="button" title="Remove" onClick={() => onChange(value.filter((x) => x !== id))}
          className="rounded-full border border-asu-gold bg-asu-gold/15 px-2 py-0.5 text-[11px] text-asu-gold hover:bg-asu-gold/25">
          {subteams.find((s) => s.id === id)?.name ?? "?"} x
        </button>
      ))}
      <select className="rounded-md border border-helios-line bg-helios-strip px-1 py-0.5 text-[11px] text-helios-dim" value=""
        onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}>
        <option value="">+ subteam</option>
        {free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

/** "2026-27" for the season that starts this summer (after competition). */
function seasonName(now = new Date()): string {
  const y = now.getMonth() >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}
