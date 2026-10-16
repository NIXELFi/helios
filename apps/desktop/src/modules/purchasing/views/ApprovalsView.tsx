import { useEffect, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import { can, decide, fetchSetting, itemCost, setStatus, type BudgetRow, type Item } from "../lib/api";
import { fmtCents } from "../lib/money";
import type { PurchasingData } from "../lib/usePurchasing";
import { Button, Card, Empty, PrioritySelect, SubteamChip } from "../components/ui";
import { partPrice } from "../components/OrderDialog";
import { NO_FILTER, WAITING_LABEL, filterApprovals, isFiltered, type ApprovalFilter } from "../lib/approvalFilter";

const FILTER_KEY = "helios:agora:approvals-filter";
function loadFilter(): ApprovalFilter {
  try { return { ...NO_FILTER, ...(JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as Partial<ApprovalFilter>) }; } catch { return NO_FILTER; }
}

/** The budget line covering an item's (car, subteam). */
export function lineFor(budgets: BudgetRow[], projectId: string, subteamId: string): BudgetRow | undefined {
  return budgets.find((b) => b.project_id === projectId && b.subteam_ids.includes(subteamId));
}

export function remaining(b: BudgetRow): number {
  return b.budget_cents - b.spent_cents - b.committed_cents;
}

export function ApprovalsView({
  client, data, userId, reload, flash,
}: {
  client: SupabaseClient;
  data: PurchasingData;
  userId: string | null;
  reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
}) {
  const { items, approvals, subteams, projects, budgets } = data;
  const [notes, setNotes] = useState<Record<string, string>>({});
  // remembered on this computer, like Abacus's view
  const [filter, setFilterState] = useState<ApprovalFilter>(loadFilter);
  const setFilter = (patch: Partial<ApprovalFilter>) => setFilterState((f) => {
    const next = { ...f, ...patch };
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  // members aren't asked for sales tax, so show a rough all-in figure where it's missing
  const [taxPct, setTaxPct] = useState<number | null>(null);
  // the approval rule is a setting (the server's decide() reads the same ones)
  const [rule, setRule] = useState({ required: 2, selfCounts: false });
  useEffect(() => {
    void fetchSetting(client, "estimated_tax_percent").then((v) => setTaxPct(v && Number(v) > 0 ? Number(v) : null));
    void Promise.all([fetchSetting(client, "approvals_required"), fetchSetting(client, "requester_counts_as_approver")])
      .then(([n, self]) => setRule({ required: Number(n) > 0 ? Number(n) : 2, selfCounts: self === "true" }));
  }, [client]);
  const now = Date.now();
  // the CFO approves alone when the approvals were given in person
  const override = can(data.caps, "purchasing.override");

  const all = items
    .filter((i) => i.status === "READY")
    .map((i) => {
      const mine = approvals.find((a) => a.item_id === i.id && a.user_id === userId);
      const hours = i.ready_at ? (now - new Date(i.ready_at).getTime()) / 3_600_000 : 0;
      const flag = hours > 14 * 24 ? "stale" : (i.priority === "HIGH" && hours > 24) || hours > 72 ? "nudge" : "";
      return { i, mine, voted: !!mine, hours, flag };
    });
  const waiting = filterApprovals(all, filter);

  async function act(i: Item, decision: "approve" | "deny") {
    try {
      const result = await decide(client, i.id, decision, notes[i.id] ?? "");
      await reload();
      flash(result === "APPROVED" ? `${i.code} approved: it's on the To order list.`
        : result === "DENIED" ? `${i.code} denied.` : `Your approval is in. ${i.code} is waiting for more.`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  async function approveNow(i: Item) {
    try {
      await setStatus(client, [i.id], "APPROVED", notes[i.id]?.trim() || "approved in person");
      await reload();
      flash(`${i.code} approved: it's on the To order list.`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  if (!all.length) return <Empty>Nothing waiting for approval.</Empty>;

  return (
    <div className="flex flex-col gap-3">
      <FilterBar all={all.map((x) => x.i)} shown={waiting.length} filter={filter} setFilter={setFilter} data={data} />
      {!waiting.length && <Empty>No requests match these filters. <button className="text-asu-gold hover:underline" onClick={() => setFilter(NO_FILTER)}>Clear them</button></Empty>}
      {waiting.map(({ i, mine, hours, flag }) => {
        const count = approvals.filter((a) => a.item_id === i.id && a.decision === "approve" && (rule.selfCounts || a.user_id !== i.requester_id)).length;
        const border = flag === "stale" ? "border-helios-danger/60" : flag === "nudge" ? "border-helios-warn/60" : "";
        return (
          <Card key={i.id} className={border}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[15px] font-semibold">{i.title}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-helios-dim">
                  <span className="font-mono">{i.code}</span>
                  {i.item_allocations.map((a) => (
                    <span key={a.subteam_id + a.project_id} className="flex items-center gap-1">
                      <SubteamChip subteam={subteams.find((s) => s.id === a.subteam_id)} />
                      {projects.find((p) => p.id === a.project_id)?.car_code}
                    </span>
                  ))}
                  <PrioritySelect priority={i.priority} editable={false} onChange={() => {}} />
                  <span>asked by <b className="text-helios-text">{i.requester_name}</b></span>
                  <span className={flag === "stale" ? "text-helios-danger" : flag === "nudge" ? "text-helios-warn" : ""}>
                    waiting {hours < 24 ? `${Math.max(1, Math.round(hours))} h` : `${Math.floor(hours / 24)} days`}{flag === "stale" ? " | over 14 days" : ""}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xl font-bold">{fmtCents(itemCost(i))}</div>
                <div className="text-xs text-helios-dim">
                  {i.quantity !== null && i.unit_price_cents !== null ? `${i.quantity} x ${fmtCents(i.unit_price_cents)}` : ""}{i.vendor ? ` | ${i.vendor}` : ""}
                </div>
                {taxPct !== null && i.actual_total_cents === null && partPrice(i) > 0 && (
                  <div className="text-xs text-helios-info" title="Adds the estimated sales tax rate (an Agora setting) on the part's price. Members usually enter only shipping in Tax/ship, if anything.">
                    about {fmtCents(itemCost(i) + Math.round(partPrice(i) * taxPct / 100))} with ~{taxPct}% tax{i.tax_shipping_cents !== null ? ", if Tax/ship has none" : ""}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="text-sm">
                {i.justification && <p className="mb-1"><span className="text-helios-dim">Why:</span> {i.justification}</p>}
                {i.notes && <p className="mb-1"><span className="text-helios-dim">Notes:</span> {i.notes}</p>}
                {i.product_url && <a className="text-asu-gold hover:underline" href={i.product_url} target="_blank" rel="noreferrer">Open product page</a>}
                <p className="mt-2 text-xs text-helios-dim">{count} of {rule.required} exec approval{rule.required === 1 ? "" : "s"}{i.requester_id === userId && !rule.selfCounts ? " | your own request doesn't count toward them" : ""}</p>
              </div>
              <table className="text-xs">
                <thead className="text-helios-dim"><tr><th className="text-left">Budget</th><th className="text-right">Left now</th><th className="text-right">After</th></tr></thead>
                <tbody>
                  {i.item_allocations.map((a) => {
                    const b = lineFor(budgets, a.project_id, a.subteam_id);
                    const share = Math.round(itemCost(i) * a.percent / 100);
                    if (!b) return <tr key={a.subteam_id}><td colSpan={3} className="text-helios-muted">No budget line covers this subteam yet</td></tr>;
                    const before = remaining(b);
                    return (
                      <tr key={a.subteam_id}>
                        <td>{b.project_code} {b.name}</td>
                        <td className="text-right">{fmtCents(before)}</td>
                        <td className={`text-right ${before - share < 0 ? "font-semibold text-helios-danger" : ""}`}>{fmtCents(before - share)}{before - share < 0 ? " | over" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input className="min-w-[220px] flex-1 rounded-md border border-helios-line bg-helios-strip px-2 py-1.5 text-sm"
                placeholder="Note (optional, shown to the requester)" value={notes[i.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [i.id]: e.target.value }))} />
              {mine && <span className={`text-xs ${mine.decision === "approve" ? "text-helios-success" : "text-helios-danger"}`}>You {mine.decision === "approve" ? "approved" : "denied"}</span>}
              <Button kind="good" disabled={mine?.decision === "approve"} onClick={() => void act(i, "approve")}>Approve</Button>
              {override && <Button kind="good" title="Approved in person: no second exec needed. Your note goes in its history."
                onClick={() => void approveNow(i)}>Approve now</Button>}
              <Button kind="danger" onClick={() => void act(i, "deny")}>Deny</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

const box = "rounded-md border border-helios-line bg-helios-strip px-2 py-1.5 text-sm";

/** Narrow the queue: who asked, for which car and subteam, how urgent, how long it's waited. */
function FilterBar({ all, shown, filter: f, setFilter, data }: {
  all: Item[]; shown: number; filter: ApprovalFilter; setFilter: (p: Partial<ApprovalFilter>) => void; data: PurchasingData;
}) {
  // only what's actually waiting, so no option leads to an empty list
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const requesters = uniq(all.map((i) => i.requester_name));
  const vendors = uniq(all.map((i) => i.vendor ?? ""));
  const teamIds = new Set(all.flatMap((i) => i.item_allocations.map((a) => a.subteam_id)));
  const carIds = new Set(all.flatMap((i) => i.item_allocations.map((a) => a.project_id)));
  const sel = (label: string, value: string, onChange: (v: string) => void, options: [string, string][], all = "All") => (
    <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-helios-dim">{label}
      <select className={`${box} font-normal normal-case tracking-normal text-helios-text ${value ? "border-asu-gold/70" : ""}`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-helios-line bg-helios-panel p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-helios-dim">Search
          <input className={`${box} font-normal normal-case tracking-normal text-helios-text`} placeholder="Part, vendor, part #, who asked, notes..."
            value={f.q} onChange={(e) => setFilter({ q: e.target.value })} />
        </label>
        {carIds.size > 1 && sel("Car", f.car, (v) => setFilter({ car: v }), data.projects.filter((p) => carIds.has(p.id)).map((p) => [p.id, p.car_code]), "Both")}
        {sel("Subteam", f.subteam, (v) => setFilter({ subteam: v }), data.subteams.filter((s) => teamIds.has(s.id)).map((s) => [s.id, s.name]))}
        {sel("Priority", f.priority, (v) => setFilter({ priority: v as ApprovalFilter["priority"] }), [["HIGH", "High"], ["Medium", "Medium"], ["Low", "Low"]], "Any")}
        {sel("Asked by", f.requester, (v) => setFilter({ requester: v }), requesters.map((r) => [r, r]), "Anyone")}
        {sel("Vendor", f.vendor, (v) => setFilter({ vendor: v }), vendors.map((v) => [v, v]), "Any")}
        {sel("Waiting", f.waiting, (v) => setFilter({ waiting: v as ApprovalFilter["waiting"] }), Object.entries(WAITING_LABEL), "Any time")}
        {sel("My vote", f.vote, (v) => setFilter({ vote: v as ApprovalFilter["vote"] }), [["todo", "Not voted yet"], ["voted", "Already voted"]], "Either")}
        {sel("Sort", f.sort, (v) => setFilter({ sort: v as ApprovalFilter["sort"] }),
          [["oldest", "Waiting longest"], ["newest", "Newest"], ["biggest", "Biggest $"], ["smallest", "Smallest $"]], "To do, then priority")}
      </div>
      <div className="flex items-center gap-3 text-xs text-helios-dim">
        <span>{isFiltered(f) ? <>Showing <b className="text-helios-text">{shown}</b> of {all.length} waiting</> : <>{all.length} waiting</>}</span>
        {isFiltered(f) && <button className="text-asu-gold hover:underline" onClick={() => setFilter({ ...NO_FILTER, sort: f.sort })}>Clear filters</button>}
      </div>
    </div>
  );
}
