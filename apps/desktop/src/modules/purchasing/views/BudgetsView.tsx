import { Fragment, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import type { PurchasingData } from "../lib/usePurchasing";
import type { BudgetRow } from "../lib/api";
import { fmtCents } from "../lib/money";
import { Button, Card, Empty, SubteamChip } from "../components/ui";
import { BudgetSetup } from "./BudgetSetup";
import { remaining } from "./ApprovalsView";
import { fetchBudgetDetail, type BudgetShare } from "../finance/api";

const BUCKET: Record<BudgetShare["bucket"], string> = { spent: "Spent", committed: "Committed (approved, not charged yet)", planned: "Planned (still on the list)" };

/** Budget per line. Click a line to see every part and charge in it. */
export function BudgetsView({ client, data, projectId, openTxn, openPart, exec, reload, flash }: {
  client: SupabaseClient; data: PurchasingData; projectId: string | null;
  exec: boolean;                           // execs set up seasons and budget lines
  reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
  openTxn?: (id: number) => void;          // execs: jump to the ledger line
  openPart: (code: string) => void;        // jump to the part on the parts list
}) {
  const { budgets, projects, subteams } = data;
  const rows = budgets.filter((b) => !projectId || b.project_id === projectId);
  const byProject = new Map<string | null, typeof rows>();
  for (const b of rows) byProject.set(b.project_id, [...(byProject.get(b.project_id) ?? []), b]);
  // Cars in the same order as the car switcher (by car code, so SDM27 before SDM27e); whole-team last.
  const carOrder = (pid: string | null) => (pid ? projects.findIndex((p) => p.id === pid) : 99);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, BudgetShare[] | "loading" | string>>({});
  const [setup, setSetup] = useState(false);

  function toggle(key: string, b: BudgetRow) {
    if (open === key) { setOpen(null); return; }
    setOpen(key);
    if (detail[key] && detail[key] !== "loading" && typeof detail[key] !== "string") return;
    setDetail((d) => ({ ...d, [key]: "loading" }));
    fetchBudgetDetail(client, b.project_id, b.subteam_ids)
      .then((x) => setDetail((d) => ({ ...d, [key]: x })))
      .catch((e) => setDetail((d) => ({ ...d, [key]: e instanceof Error ? e.message : String(e) })));
  }

  const setupCard = setup && <BudgetSetup client={client} data={data} reload={reload} flash={flash} done={() => setSetup(false)} />;
  if (!rows.length) {
    return (
      <div className="flex flex-col gap-4">
        {setupCard || <Empty>No budget lines you can see yet. Execs set them per car and season.
          {exec && <div className="mt-3"><Button onClick={() => setSetup(true)}>Set up budgets</Button></div>}</Empty>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {setupCard || (exec && <div className="flex justify-end"><Button kind="ghost" onClick={() => setSetup(true)}>Set up budgets</Button></div>)}
      <p className="text-xs text-helios-dim">
        Remaining = budget - spent - committed. "After planned" also takes off parts still on the list: if it goes negative, the plan doesn't fit the budget.
        <b className="text-helios-text"> Click a line to see what's in it.</b>
        <span className="ml-3 inline-flex items-center gap-1"><i className="inline-block size-2 rounded-sm bg-helios-success" />spent</span>
        <span className="ml-2 inline-flex items-center gap-1"><i className="inline-block size-2 rounded-sm bg-violet-400" />committed</span>
        <span className="ml-2 inline-flex items-center gap-1"><i className="inline-block size-2 rounded-sm bg-helios-info/60" />planned</span>
      </p>
      {[...byProject.entries()].sort(([a], [b]) => carOrder(a) - carOrder(b)).map(([pid, lines]) => {
        const project = projects.find((p) => p.id === pid);
        const totals = lines.reduce((t, b) => ({ budget: t.budget + b.budget_cents, left: t.left + remaining(b) }), { budget: 0, left: 0 });
        return (
          <Card key={pid ?? "team"} className="p-0">
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <h2 className="font-semibold">{project ? <>{project.car_code} <span className="text-helios-dim">{project.name}</span></> : <>Team <span className="text-helios-dim">shared by both cars</span></>}</h2>
              <span className="text-xs text-helios-dim">{fmtCents(totals.budget)} budget | <b className={totals.left < 0 ? "text-helios-danger" : "text-helios-text"}>{fmtCents(totals.left)} left</b></span>
            </div>
            <table className="w-full text-[13px]">
              <thead className="text-[11px] uppercase tracking-wider text-helios-dim">
                <tr>
                  <th className="p-2 text-left">Budget line</th><th className="p-2 text-right">Budget</th><th className="p-2 text-right">Spent</th>
                  <th className="p-2 text-right">Committed</th><th className="p-2 text-right">Planned</th><th className="p-2 text-right">Remaining</th>
                  <th className="p-2 text-right">After planned</th><th className="w-1/5 p-2" />
                </tr>
              </thead>
              <tbody>
                {lines.sort((a, b) => b.budget_cents - a.budget_cents).map((b) => {
                  const left = remaining(b);
                  const after = left - b.planned_cents;
                  const cap = Math.max(b.budget_cents, b.spent_cents + b.committed_cents + b.planned_cents, 1);
                  const key = (b.budget_line_id ?? b.name) + (pid ?? "team");
                  const d = detail[key];
                  return (
                    <Fragment key={key}>
                      <tr className={`cursor-pointer border-t border-helios-line hover:bg-helios-strip ${open === key ? "bg-helios-strip" : ""}`} onClick={() => toggle(key, b)}>
                        <td className="p-2">
                          <div className="font-semibold"><span className="mr-1 text-helios-muted">{open === key ? "v" : ">"}</span>{b.name}</div>
                          <div className="mt-0.5 flex gap-1">{b.subteam_ids.map((id) => <SubteamChip key={id} subteam={subteams.find((s) => s.id === id)} />)}</div>
                        </td>
                        <td className="p-2 text-right">{fmtCents(b.budget_cents)}</td>
                        <td className="p-2 text-right">{fmtCents(b.spent_cents)}</td>
                        <td className="p-2 text-right">{fmtCents(b.committed_cents)}</td>
                        <td className="p-2 text-right text-helios-dim">{fmtCents(b.planned_cents)}</td>
                        <td className={`p-2 text-right font-semibold ${left < 0 ? "text-helios-danger" : ""}`}>{fmtCents(left)}</td>
                        <td className={`p-2 text-right ${after < 0 ? "text-helios-danger" : ""}`}>{fmtCents(after)}</td>
                        <td className="p-2">
                          <div className="flex h-2 overflow-hidden rounded-full bg-helios-strip">
                            <i className="block bg-helios-success" style={{ width: `${(Math.max(0, b.spent_cents) / cap) * 100}%` }} />
                            <i className="block bg-violet-400" style={{ width: `${(b.committed_cents / cap) * 100}%` }} />
                            <i className="block bg-helios-info/60" style={{ width: `${(b.planned_cents / cap) * 100}%` }} />
                          </div>
                          {!b.budget_line_id && <div className="text-[11px] text-helios-warn">no budget line covers this</div>}
                        </td>
                      </tr>
                      {open === key && (
                        <tr className="bg-helios-base/40">
                          <td colSpan={8} className="px-6 py-3">
                            {d === "loading" || d === undefined ? <span className="text-xs text-helios-dim">Loading...</span>
                              : typeof d === "string" ? <span className="text-xs text-helios-danger">{d}</span>
                              : !d.length ? <span className="text-xs text-helios-dim">Nothing in this line yet.</span>
                              : <Detail shares={d} openTxn={openTxn} openPart={openPart} noLine={!b.budget_line_id} />}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        );
      })}
    </div>
  );
}

function Detail({ shares, openTxn, openPart, noLine }: {
  shares: BudgetShare[]; openTxn?: (id: number) => void; openPart: (code: string) => void; noLine: boolean;
}) {
  const groups = (["spent", "committed", "planned"] as const).map((k) => [k, shares.filter((s) => s.bucket === k)] as const).filter(([, xs]) => xs.length);
  return (
    <div className="flex flex-col gap-3">
      {noLine && <p className="text-xs text-helios-dim">This spending is tagged to a subteam that no budget line covers. An exec can add a budget line for it, or re-tag the charges in the Ledger.</p>}
      {groups.map(([k, xs]) => (
        <div key={k}>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-helios-dim">{BUCKET[k]} | {fmtCents(xs.reduce((s, x) => s + x.cents, 0))}</div>
          <table className="w-full text-xs">
            <tbody>
              {xs.map((x, i) => (
                <tr key={i} className="border-t border-helios-line">
                  <td className="w-24 py-1 text-helios-dim">{x.on_date ?? ""}</td>
                  <td className="w-28 py-1">{x.source === "part" ? <span className="font-mono text-helios-dim">{x.ref}</span> : <span className="text-helios-dim">card / bank</span>}</td>
                  <td className="py-1">{x.label}</td>
                  <td className="w-24 py-1 text-right tabular-nums">{fmtCents(x.cents)}</td>
                  <td className="w-28 py-1 text-right">
                    {x.source === "part" ? <button className="text-asu-gold hover:underline" onClick={() => openPart(x.ref)}>Show part</button>
                      : x.txn_id && openTxn ? <button className="text-asu-gold hover:underline" onClick={() => openTxn(x.txn_id!)}>Ledger line</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
