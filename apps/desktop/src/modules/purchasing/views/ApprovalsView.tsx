import { useEffect, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import { decide, fetchSetting, itemCost, type BudgetRow, type Item } from "../lib/api";
import { fmtCents } from "../lib/money";
import type { PurchasingData } from "../lib/usePurchasing";
import { Button, Card, Empty, PrioritySelect, SubteamChip } from "../components/ui";

const PRIORITY_ORDER = { HIGH: 0, Medium: 1, Low: 2 } as const;

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
  // members aren't asked for sales tax, so show a rough all-in figure where it's missing
  const [taxPct, setTaxPct] = useState<number | null>(null);
  useEffect(() => { void fetchSetting(client, "estimated_tax_percent").then((v) => setTaxPct(v && Number(v) > 0 ? Number(v) : null)); }, [client]);
  const now = Date.now();

  const waiting = items
    .filter((i) => i.status === "READY")
    .map((i) => {
      const mine = approvals.find((a) => a.item_id === i.id && a.user_id === userId);
      const hours = i.ready_at ? (now - new Date(i.ready_at).getTime()) / 3_600_000 : 0;
      const flag = hours > 14 * 24 ? "stale" : (i.priority === "HIGH" && hours > 24) || hours > 72 ? "nudge" : "";
      return { i, mine, hours, flag };
    })
    .sort((a, b) => Number(!!a.mine) - Number(!!b.mine)
      || PRIORITY_ORDER[a.i.priority] - PRIORITY_ORDER[b.i.priority] || b.hours - a.hours);

  async function act(i: Item, decision: "approve" | "deny") {
    try {
      const result = await decide(client, i.id, decision, notes[i.id] ?? "");
      await reload();
      flash(result === "APPROVED" ? `${i.code} approved: it's on the To order list.`
        : result === "DENIED" ? `${i.code} denied.` : `Your approval is in. ${i.code} needs one more.`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  if (!waiting.length) return <Empty>Nothing waiting for approval.</Empty>;

  return (
    <div className="flex flex-col gap-3">
      {waiting.map(({ i, mine, hours, flag }) => {
        const count = approvals.filter((a) => a.item_id === i.id && a.decision === "approve" && a.user_id !== i.requester_id).length;
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
                {taxPct !== null && i.tax_shipping_cents === null && i.actual_total_cents === null && itemCost(i) > 0 && (
                  <div className="text-xs text-helios-info" title="No tax or shipping was entered. This adds the estimated sales tax rate (an Agora setting); shipping isn't included.">
                    about {fmtCents(Math.round(itemCost(i) * (1 + taxPct / 100)))} with ~{taxPct}% tax
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="text-sm">
                {i.justification && <p className="mb-1"><span className="text-helios-dim">Why:</span> {i.justification}</p>}
                {i.notes && <p className="mb-1"><span className="text-helios-dim">Notes:</span> {i.notes}</p>}
                {i.product_url && <a className="text-asu-gold hover:underline" href={i.product_url} target="_blank" rel="noreferrer">Open product page</a>}
                <p className="mt-2 text-xs text-helios-dim">{count} of 2 exec approvals{i.requester_id === userId ? " | your own request doesn't count toward them" : ""}</p>
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
              <Button kind="danger" onClick={() => void act(i, "deny")}>Deny</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
