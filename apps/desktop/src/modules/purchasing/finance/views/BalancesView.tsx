import { useMemo, useState } from "react";
import { fmtCents, fmtSigned, parseCents } from "../../lib/money";
import { Button, Card } from "../../components/ui";
import { addBalance } from "../api";
import { closingsByCard } from "../compute";
import { cardHeadroom, cardOwed, projectedBankBalance, reconcile, type Account, type BalanceEntry, type ReconRow } from "../ledger";
import { today } from "../../lib/dates";
import { Badge, Bar, Sparkline, accountLabel, attempt, input, shortDate, type FinanceProps } from "./shared";

const KIND_NOTE: Record<Account["kind"], string> = {
  checking: "Bank account", credit_card: "Available credit this cycle (PaymentNet)", holding: "Holding",
  university: "ASU account", crowdfunding: "Crowdfunding",
};
const ORDER: Record<Account["kind"], number> = { checking: 0, credit_card: 1, holding: 2, university: 3, crowdfunding: 4 };

/** Weekly balances: click a balance to type this week's number. Every entry is kept. */
export function BalancesView({ client, fin, reload, flash, me }: FinanceProps) {
  const now = today();
  const closings = closingsByCard(fin);
  const recon = useMemo(() => new Map<number, ReconRow>(fin.accounts.flatMap((a) => reconcile(fin.txns, fin.balances, a)).map((r) => [r.entry.id, r])), [fin]);
  const accounts = [...fin.accounts].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.id - b.id);
  const [allOpen, setAllOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-helios-dim">Click a balance to type this week's number. Every entry is kept as history, and the ledger checks it against what it computed.</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {accounts.map((a) => <AccountCard key={a.id} a={a} {...{ client, fin, reload, flash, me, now, closings, recon }} />)}
      </div>
      <Card className="p-0">
        <button className="w-full px-4 py-3 text-left font-semibold" onClick={() => setAllOpen((o) => !o)}>
          {allOpen ? "v" : ">"} Every entry and its reconciliation ({fin.balances.length})
        </button>
        {allOpen && (
          <div className="overflow-auto border-t border-helios-line">
            <table className="w-full text-sm">
              <thead className="bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
                <tr><th className="p-2 text-left">As of</th><th className="p-2 text-left">Account</th><th className="p-2 text-right">Entered</th><th className="p-2 text-right">Ledger computes</th><th className="p-2 text-right">Difference</th><th className="p-2 text-left">Entered by</th></tr>
              </thead>
              <tbody>
                {[...fin.balances].reverse().map((e) => {
                  const r = recon.get(e.id);
                  return (
                    <tr key={e.id} className="border-t border-helios-line">
                      <td className="p-2 whitespace-nowrap">{e.as_of}</td>
                      <td className="p-2">{accountLabel(fin.accounts.find((a) => a.id === e.account_id))}{e.measure === "available_credit" && <span className="text-xs text-helios-dim"> (available credit)</span>}</td>
                      <td className="p-2 text-right tabular-nums">{fmtCents(e.balance_cents)}</td>
                      <td className="p-2 text-right tabular-nums text-helios-dim">{r?.computed_cents != null ? fmtCents(r.computed_cents) : "-"}</td>
                      <td className="p-2 text-right">{r?.difference_cents ? <Badge tone="bad">{fmtSigned(r.difference_cents)}</Badge> : r?.difference_cents === 0 ? <Badge tone="good">ties out</Badge> : <span className="text-xs text-helios-muted">starting point</span>}</td>
                      <td className="p-2 text-xs">{e.entered_by_name}{e.note && <div className="text-helios-dim">{e.note}</div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AccountCard({ a, client, fin, reload, flash, me, now, closings, recon }: Pick<FinanceProps, "client" | "fin" | "reload" | "flash" | "me"> & {
  a: Account; now: string; closings: Record<number, string[]>; recon: Map<number, ReconRow>;
}) {
  const card = a.kind === "credit_card";
  const measure: BalanceEntry["measure"] = card ? "available_credit" : "balance";
  const mine = fin.balances.filter((e) => e.account_id === a.id && e.measure === measure);
  const latest = mine.at(-1) ?? null;
  const headroom = card ? cardHeadroom(fin.txns, a, now, closings[a.id] ?? [], fin.balances) : null;
  const owed = card ? cardOwed(fin.txns, a, now) : null;
  const lastRecon = latest ? recon.get(latest.id) : undefined;
  const computed = card ? headroom!.remaining_cents
    : a.kind === "checking" ? (lastRecon?.computed_cents ?? projectedBankBalance(fin.txns, fin.balances.filter((e) => e.confirmed), a, now).balance)
    : null;
  const autopay = card ? fin.txns.filter((t) => t.account_id === a.id && t.kind === "transfer" && t.status === "expected" && t.date >= now)
    .sort((x, y) => (x.date < y.date ? -1 : 1))[0] : undefined;

  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(now);
  const [note, setNote] = useState("");
  const [showHistory, setShowHistory] = useState(mine.length <= 4);

  async function save() {
    let cents = parseCents(amount.replace(/\s/g, ""));
    if (cents === null) { flash("That isn't an amount.", true); return; }
    if (card) cents = Math.abs(cents);
    const ok = await attempt(flash, reload, `${a.name}: ${card ? "available credit" : "balance"} ${fmtCents(cents)} recorded`,
      () => addBalance(client, { account_id: a.id, as_of: asOf || now, balance_cents: cents!, measure, note, entered_by_name: me }));
    if (ok) { setEditing(false); setAmount(""); setNote(""); }
  }

  const history = mine.map((e, i) => ({ e, change: i ? e.balance_cents - mine[i - 1]!.balance_cents : null })).reverse();

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <b>{a.name}</b>{a.last4 && !a.name.includes(a.last4) && <span className="ml-1 font-mono text-xs text-helios-dim">...{a.last4}</span>}
          <div className="text-xs text-helios-dim">{KIND_NOTE[a.kind]}{!a.active && " | on hold"}</div>
        </div>
        {lastRecon?.difference_cents ? <Badge tone="bad" title="Entered balance minus what the ledger computes">{fmtSigned(lastRecon.difference_cents)} unexplained</Badge>
          : lastRecon?.difference_cents === 0 ? <Badge tone="good">ties out</Badge> : null}
      </div>

      {!editing ? (
        <button className="group my-2 block text-left text-3xl font-semibold tabular-nums hover:text-asu-gold" title="Click to enter a new balance"
          onClick={() => { setEditing(true); setAsOf(now); }}>
          {latest ? fmtCents(latest.balance_cents) : computed !== null ? fmtCents(computed) : <span className="text-base text-helios-muted">No balance yet</span>}
          <span className="ml-2 text-sm text-helios-muted group-hover:text-asu-gold">edit</span>
        </button>
      ) : (
        <form className="my-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input autoFocus className={`${input} w-32`} placeholder={card ? "Available credit" : "Balance"} value={amount} onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }} />
          <input type="date" className={input} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <input className={`${input} min-w-[120px] flex-1`} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="submit">Save</Button>
          <Button kind="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}

      <div className="text-xs text-helios-dim">
        {latest && <>{shortDate(latest.as_of)} | {latest.entered_by_name}{!latest.confirmed && <> <Badge tone="warn">unconfirmed</Badge></>}</>}
        {headroom && (
          <div className="mt-1">
            Cycle since {headroom.cycle_start ? shortDate(headroom.cycle_start) : "?"}: {fmtCents(headroom.posted_cents)} posted
            {headroom.pending_cents ? ` + ${fmtCents(headroom.pending_cents)} pending` : ""} of {fmtCents(headroom.limit_cents)}
            <div className="my-1.5"><Bar fraction={headroom.fraction_used} level={headroom.level} /></div>
            Still owed from statements: {fmtCents(owed)}{autopay ? `, autopay from checking around ${shortDate(autopay.date)}` : ""}
          </div>
        )}
        {!card && computed !== null && <div className="mt-1">Statements + logged activity predict {fmtCents(computed)}</div>}
      </div>

      <div className="mt-2"><Sparkline points={mine.filter((e) => e.confirmed).map((e) => [e.as_of, e.balance_cents])} /></div>

      {history.length > 0 && (
        <div className="mt-2">
          <button className="text-xs text-helios-dim hover:text-helios-text" onClick={() => setShowHistory((s) => !s)}>{showHistory ? "v" : ">"} History ({history.length})</button>
          {showHistory && (
            <table className="mt-1 w-full text-xs">
              <tbody>
                {history.slice(0, 12).map(({ e, change }) => (
                  <tr key={e.id} className="border-t border-helios-line">
                    <td className="py-1 whitespace-nowrap">{shortDate(e.as_of)}</td>
                    <td className="py-1 text-right tabular-nums">{fmtCents(e.balance_cents)}</td>
                    <td className={`py-1 text-right tabular-nums ${change && change > 0 ? "text-helios-success" : change && change < 0 ? "text-helios-danger" : ""}`}>{change ? fmtSigned(change) : ""}</td>
                    <td className="py-1 pl-2 text-helios-muted">{e.entered_by_name === "Chase statement" ? "statement" : e.entered_by_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}
