// Page-level sums built from the pure ledger functions: the dashboard figures
// and the open/resolved discrepancy lists.

import type { Item } from "../lib/api";
import type { FinanceData } from "./useFinance";
import { evidenceFor } from "./evidence";
import { bySeverity, findDiscrepancies, type Discrepancy, type Evidence } from "./discrepancies";
import {
  available, cardHeadroom, cardOwed, latestBalance, outstandingChecks, reconcile, teamFunds,
  type Account, type AvailableSummary, type BalanceEntry, type CardHeadroom, type ReconRow, type TeamFunds, type Txn,
} from "./ledger";

export interface CardStatus { account: Account; headroom: CardHeadroom; owed: number; autopay: Txn | null }

export interface Dashboard {
  asOf: string;
  checking: Account | null;
  summary: AvailableSummary | null;
  /** Chase's Available plus every other account's balance (ASU, cash box, GoFundMe). */
  funds: TeamFunds;
  cards: CardStatus[];
  recon: ReconRow[];
  others: { account: Account; entry: BalanceEntry | null }[];
  outstanding: Txn[];
  /** a typed-in checking balance newer than the one Available is using, but not confirmed */
  unconfirmed: BalanceEntry | null;
}

export function closingsByCard(fin: FinanceData): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const s of fin.statements) (out[s.account_id] ??= []).push(s.closing_date);
  return out;
}

export function dashboard(fin: FinanceData, asOf: string): Dashboard {
  const { accounts, txns, balances } = fin;
  const checking = accounts.find((a) => a.kind === "checking" && a.active) ?? accounts.find((a) => a.kind === "checking") ?? null;
  const cards = accounts.filter((a) => a.kind === "credit_card");
  const closings = closingsByCard(fin);
  const reimbs = fin.reimbursements;
  const summary = checking ? available(txns, balances, reimbs, checking, cards, asOf, closings) : null;
  const latestAny = checking ? latestBalance(balances, checking.id, asOf) : null;
  const unconfirmed = latestAny && !latestAny.confirmed && summary?.bank_balance_basis && latestAny.as_of > summary.bank_balance_basis.as_of ? latestAny : null;
  return {
    asOf, checking, summary, unconfirmed,
    funds: teamFunds(txns, balances, accounts, checking, summary?.available_cents ?? null, asOf),
    cards: cards.map((c) => ({
      account: c,
      headroom: cardHeadroom(txns, c, asOf, closings[c.id] ?? [], balances),
      owed: cardOwed(txns, c, asOf),
      autopay: txns.filter((t) => t.account_id === c.id && t.kind === "transfer" && t.status === "expected" && t.date >= asOf)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null,
    })),
    recon: accounts.flatMap((a) => reconcile(txns, balances, a)),
    others: accounts.filter((a) => a.kind !== "checking" && a.kind !== "credit_card")
      .map((a) => ({ account: a, entry: latestBalance(balances, a.id, asOf) })),
    outstanding: checking ? outstandingChecks(txns, checking, asOf) : [],
  };
}

export function allEvidence(fin: FinanceData, items: Item[], where: (p: string | null, s: string | null) => string): Evidence[] {
  return evidenceFor(fin.evidence, items, where);
}

export function discrepancies(fin: FinanceData, evidence: Evidence[]): { open: Discrepancy[]; resolved: { d: Discrepancy; note: string; by: string; at: string }[] } {
  const recon = fin.accounts.flatMap((a) => reconcile(fin.txns, fin.balances, a));
  const closes = fin.statements.map((s) => s.closing_date).sort();
  // a card cycle runs about a month back from its closing date
  const firstStart = closes[0] ? new Date(Date.parse(closes[0]) - 30 * 86_400_000).toISOString().slice(0, 10) : null;
  const found = findDiscrepancies(fin.txns, evidence, fin.reimbursements, recon, firstStart);
  // A gap after the last statement usually just means the next statement isn't in yet.
  const lastEnd = new Map<number, string>();
  for (const s of fin.statements) if (!lastEnd.has(s.account_id) || s.closing_date > lastEnd.get(s.account_id)!) lastEnd.set(s.account_id, s.closing_date);
  for (const d of found) {
    if (!d.key.startsWith("recon:")) continue;
    const end = lastEnd.get(Number(d.key.split(":")[1]));
    if (end) d.message += `. The last statement for this account ends ${end}, so this is probably activity since then: import the next statement to explain it.`;
  }
  found.sort(bySeverity);
  const res = new Map(fin.resolutions.map((r) => [r.key, r]));
  return {
    open: found.filter((d) => !res.has(d.key)),
    resolved: found.filter((d) => res.has(d.key)).map((d) => {
      const r = res.get(d.key)!;
      return { d, note: r.note, by: r.resolved_by_name, at: r.resolved_at };
    }),
  };
}
