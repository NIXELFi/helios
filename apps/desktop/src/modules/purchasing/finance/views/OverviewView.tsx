import { useMemo, useState } from "react";
import { itemCost } from "../../lib/api";
import { fmtCents, fmtSigned } from "../../lib/money";
import { Card } from "../../components/ui";
import { allEvidence, dashboard, discrepancies } from "../compute";
import { claimsACharge } from "../discrepancies";
import { isSpend } from "../ledger";
import { today } from "../useFinance";
import { Badge, Bar, Money, Tile, accountLabel, input, shortDate, whereLabel, type FinanceProps } from "./shared";

export type FinanceView = "overview" | "balances" | "ledger" | "reimbursements" | "discrepancies" | "accounts";

/** The exec dashboard: what the team can actually spend, the card, and what needs attention. */
export function OverviewView({ fin, pur, openTxn, go }: FinanceProps & { go: (v: FinanceView | "approvals" | "orders") => void }) {
  const [asOf, setAsOf] = useState(today());
  const d = useMemo(() => dashboard(fin, asOf), [fin, asOf]);
  const where = whereLabel(pur);
  const evidence = useMemo(() => allEvidence(fin, pur.items, where), [fin, pur.items]);
  const disc = useMemo(() => discrepancies(fin, evidence), [fin, evidence]);
  const s = d.summary;

  const counts = { high: 0, medium: 0, low: 0 };
  for (const x of disc.open) counts[x.severity]++;
  const unassigned = fin.txns.filter((t) => isSpend(t) && t.status === "posted" && !t.txn_allocations.length).length;
  const needsCategory = fin.txns.filter((t) => t.category === "Needs category" && t.kind !== "transfer").length;
  const unmatched = evidence.filter((e) => e.txn_id === null && claimsACharge(e) && e.kind !== "request" && e.kind !== "airtable").length;
  const waitingReview = fin.reimbursements.filter((r) => r.status === "requested").length;
  const pipeline = (st: string) => {
    const xs = pur.items.filter((i) => i.status === st);
    return [xs.length, xs.reduce((a, i) => a + itemCost(i), 0)] as const;
  };
  const lastRecon = d.checking ? d.recon.filter((r) => r.account_id === d.checking!.id).at(-1) : undefined;
  const recent = [...fin.txns].filter((t) => t.date <= asOf).sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1)).slice(0, 8);

  if (!d.checking) return <Card>No checking account yet. Add one under Accounts.</Card>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-helios-dim">Execs only. Figures as of {shortDate(asOf)}.</p>
        <label className="flex items-center gap-2 text-xs text-helios-dim">View as of
          <input type="date" className={input} value={asOf} onChange={(e) => setAsOf(e.target.value || today())} />
        </label>
      </div>

      {d.unconfirmed && s?.bank_balance_cents != null && (
        <div className="rounded-md border border-asu-gold/50 bg-asu-gold/10 px-3 py-2 text-sm">
          {d.unconfirmed.entered_by_name} says the {d.checking.name} balance was {fmtCents(d.unconfirmed.balance_cents)} on {shortDate(d.unconfirmed.as_of)},
          but the statements only explain {fmtCents(s.bank_balance_cents)}. Available uses the statements until you{" "}
          <button className="text-asu-gold underline" onClick={() => go("balances")}>enter this week's real balance</button>.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile hero label="Available to spend" value={<Money cents={s?.available_cents} />} note="Bank − card owed − uncashed checks − reimbursements owed" />
        <Tile label={`${d.checking.name} balance`} value={<Money cents={s?.bank_balance_cents} />}
          note={s?.bank_balance_basis ? `${s.bank_balance_basis.entered_by_name === "Chase statement" ? "Statement" : "Entered"} ${shortDate(s.bank_balance_basis.as_of)} + logged since` : "Not entered yet"} />
        <Tile label="Card owed" value={<Money cents={(s?.card_owed_cents ?? 0) + (s?.card_pending_cents ?? 0)} />}
          note={<>Not yet paid from checking{s?.card_pending_cents ? ` + ${fmtCents(s.card_pending_cents)} pending` : ""}</>} />
        <Tile label="Uncashed checks" value={<Money cents={s?.outstanding_checks_cents} />} note={`${d.outstanding.length} outstanding`} />
        <Tile label="Reimbursements owed" value={<Money cents={s?.reimbursements_owed_cents} />}
          note={<button className="hover:underline" onClick={() => go("reimbursements")}>
            {fin.reimbursements.filter((r) => r.status === "owed" || r.status === "requested").length} unpaid
            {waitingReview ? `, ${waitingReview} to review` : ""}{s?.reimbursements_missing_amount ? `, ${s.reimbursements_missing_amount} with no amount` : ""}
          </button>} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {d.cards.map(({ account, headroom: h, owed, autopay }) => (
          <Card key={account.id}>
            <div className="flex items-center justify-between"><b>Card credit used</b><span className="text-xs text-helios-dim">{accountLabel(account)}</span></div>
            <div className="my-3 flex items-center justify-between">
              <span className="text-lg font-semibold tabular-nums">{fmtCents(h.used_cents)} <span className="text-sm text-helios-dim">of {fmtCents(h.limit_cents)}</span></span>
              <Badge tone={h.level === "danger" ? "bad" : h.level === "warn" ? "warn" : "good"}>{fmtCents(h.remaining_cents)} left</Badge>
            </div>
            <Bar fraction={h.fraction_used} level={h.level} />
            <p className="mt-2 text-xs text-helios-dim">
              The limit is per billing cycle and resets when a statement closes. This cycle{h.cycle_start ? ` (since ${shortDate(h.cycle_start)})` : ""}:{" "}
              {fmtCents(h.posted_cents)} posted{h.pending_cents ? ` + ${fmtCents(h.pending_cents)} pending` : ""}.{" "}
              {h.basis ? `Pending figure from the PaymentNet check on ${shortDate(h.basis.as_of)}.`
                : <button className="text-asu-gold hover:underline" onClick={() => go("balances")}>Enter PaymentNet's available credit</button>}
              {" "}Still owed from statements: {fmtCents(owed)}{autopay ? `, autopay from checking around ${shortDate(autopay.date)}` : ""}.
            </p>
            {h.level === "danger" && <p className="mt-1 text-xs font-semibold text-helios-danger">At or near this cycle's limit: charges will decline. Wait for the statement to close or pay by check.</p>}
          </Card>
        ))}

        <Card>
          <b>Purchasing</b>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {([["READY", "Waiting approval", "approvals"], ["APPROVED", "To order", "orders"], ["ORDERED", "Ordered", "orders"], ["SHIPPED", "Shipped", "orders"]] as const).map(([st, lbl, v]) => {
              const [n, cents] = pipeline(st);
              return (
                <button key={st} onClick={() => go(v)} className="rounded-md border border-helios-line p-2 text-left hover:bg-helios-strip">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-helios-dim">{lbl}</div>
                  <div className="text-lg font-semibold">{n}</div>
                  <div className="text-xs text-helios-dim">{fmtCents(cents)}</div>
                </button>
              );
            })}
          </div>
          <b className="mt-4 block">Needs attention</b>
          <button className="mt-1 flex gap-1" onClick={() => go("discrepancies")}>
            <Badge tone="bad">{counts.high} high</Badge><Badge tone="warn">{counts.medium} medium</Badge><Badge>{counts.low} low</Badge>
          </button>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
            <li><button className="hover:underline" onClick={() => go("ledger")}>{unassigned} charges</button> have no subteam yet{needsCategory ? `, ${needsCategory} no category` : ""}</li>
            <li>{unmatched} invoices or order emails aren't matched to a charge</li>
            {waitingReview > 0 && <li><button className="hover:underline" onClick={() => go("reimbursements")}>{waitingReview} reimbursement request{waitingReview > 1 ? "s" : ""}</button> to review</li>}
            {d.cards.map(({ account, headroom }) => (
              <li key={account.id}>{account.name}: {headroom.basis ? <Badge tone="good">PaymentNet checked {shortDate(headroom.basis.as_of)}</Badge> : <Badge>check PaymentNet this cycle</Badge>}</li>
            ))}
            <li>{d.checking.name}: {!lastRecon ? <Badge>no balance entered</Badge> : lastRecon.difference_cents === null ? <Badge>starting balance only</Badge>
              : lastRecon.difference_cents === 0 ? <Badge tone="good">ties out</Badge> : <Badge tone="bad">{fmtSigned(lastRecon.difference_cents)} unexplained</Badge>}</li>
          </ul>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between"><b>Other accounts</b><button className="text-xs text-asu-gold hover:underline" onClick={() => go("balances")}>Update balances</button></div>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {d.others.map(({ account, entry }) => (
                <tr key={account.id} className="border-t border-helios-line">
                  <td className="py-1.5">{account.name}{!account.active && <> <Badge>on hold</Badge></>}</td>
                  <td className="py-1.5 text-right"><Money cents={entry?.balance_cents} /></td>
                  <td className="py-1.5 pl-3 text-xs text-helios-dim">{entry ? shortDate(entry.as_of) : ""}{entry && !entry.confirmed && <> <Badge tone="warn">unconfirmed</Badge></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <div className="flex items-center justify-between"><b>Latest activity</b><button className="text-xs text-asu-gold hover:underline" onClick={() => go("ledger")}>Full ledger →</button></div>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {recent.map((t) => (
                <tr key={t.id} className={`cursor-pointer border-t border-helios-line hover:bg-helios-strip ${t.status === "expected" ? "opacity-60" : ""}`} onClick={() => openTxn(t.id)}>
                  <td className="whitespace-nowrap py-1.5 text-xs text-helios-dim">{shortDate(t.date)}</td>
                  <td className="py-1.5">{t.vendor || t.description}{t.status === "expected" && <> <Badge>expected</Badge></>}</td>
                  <td className="py-1.5 text-right"><Money cents={t.amount_cents} signed /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <p className="text-xs text-helios-muted">Spending by subteam against budget is on Budgets. Every figure here is computed from statement lines; invoices and parts rows never add money.</p>
    </div>
  );
}
