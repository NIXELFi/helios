// Ledger maths: balances, card owed and headroom, Available, reconciliation.
//
// The counting rule: money is counted once, on the statement line where it
// moved. Card purchases count on the card. The card payment from checking is
// a transfer and never counts as spending. Invoices and parts-list rows never
// add money.
//
// Plain data in, plain data out: nothing here touches Supabase or React, so
// it is tested on its own (see __tests__/ledger.test.ts). Dates are ISO
// 'YYYY-MM-DD' strings, which compare correctly as strings.
//
// Sign convention for amount_cents on every account: negative = money leaving
// the team, positive = money arriving. On a card the amount owed is therefore
// minus the sum of its transactions. A card payment is a pair of transfers:
// -X on checking and +X on the card.

export type AccountKind = "checking" | "credit_card" | "holding" | "university" | "crowdfunding";
export type TxnKind = "charge" | "credit" | "deposit" | "withdrawal" | "check" | "transfer" | "fee";

export const SPEND_KINDS: ReadonlySet<TxnKind> = new Set(["charge", "check", "withdrawal", "fee"]);
export const ALL_KINDS: TxnKind[] = ["charge", "credit", "deposit", "withdrawal", "check", "transfer", "fee"];

export interface Account {
  id: number;
  name: string;
  kind: AccountKind;
  last4: string | null;
  holder: string | null;
  credit_limit_cents: number | null;
  paid_from_account_id: number | null;
  project_id: string | null;
  active: boolean;
  notes: string;
}

export interface TxnAllocation { id?: number; project_id: string | null; subteam_id: string; amount_cents: number }

export interface Txn {
  id: number;
  account_id: number;
  date: string;
  post_date: string | null;
  cleared_date: string | null;
  amount_cents: number;
  description: string;
  vendor: string | null;
  kind: TxnKind;
  category: string;
  reference: string | null;
  status: "posted" | "expected";
  transfer_group: string | null;
  needs_review: boolean;
  review_note: string;
  source: string;
  statement_id: number | null;
  notes: string;
  allocation_basis: string;
  txn_allocations: TxnAllocation[];
}

export interface BalanceEntry {
  id: number;
  account_id: number;
  as_of: string;
  balance_cents: number;
  measure: "balance" | "available_credit";
  confirmed: boolean;
  note: string;
  entered_by_name: string;
  entered_at: string;
}

export type ReimbursementStatus = "requested" | "owed" | "paid" | "denied";
export interface Reimbursement {
  id: number;
  person_name: string;
  user_id: string | null;
  amount_cents: number | null;
  reason: string;
  project_id: string | null;
  subteam_id: string | null;
  item_id: string | null;
  requested_date: string | null;
  status: ReimbursementStatus;
  denied_reason: string;
  check_number: string | null;
  check_txn_id: number | null;
  paid_date: string | null;
  notes: string;
  created_at: string;
}

export interface Statement {
  id: number;
  account_id: number;
  period_start: string | null;
  closing_date: string;
  opening_cents: number | null;
  ending_cents: number | null;
  net_charges_cents: number;
  source_file: string;
  sha256?: string | null;
}

export const CARD_WARN_FRACTION = 0.8;
export const CARD_DANGER_FRACTION = 0.95;

export const isTransfer = (t: Txn) => t.kind === "transfer";
export const isSpend = (t: Txn) => SPEND_KINDS.has(t.kind);
/** Unpaid and not turned down: money the team owes someone. */
export const isOwed = (r: Reimbursement) => r.status === "owed" || r.status === "requested";

/** The day a transaction changes the bank's own balance. A check reduces it
 *  only when it clears; until then it is an outstanding check. */
export function bankEffectiveDate(t: Txn): string | null {
  if (t.kind === "check") return t.cleared_date;
  return t.post_date ?? t.date;
}

const forAccount = (txns: Txn[], accountId: number) => txns.filter((t) => t.account_id === accountId);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const latestOf = <T extends { as_of: string; id: number }>(xs: T[]): T | null =>
  xs.reduce<T | null>((best, e) => (!best || e.as_of > best.as_of || (e.as_of === best.as_of && e.id > best.id) ? e : best), null);

// ---------------------------------------------------------------- card

/** What the team owes on the card at the end of asOf (>= 0 normally). */
export function cardOwed(txns: Txn[], card: Account, asOf: string): number {
  return 0 - sum(forAccount(txns, card.id).filter((t) => t.date <= asOf).map((t) => t.amount_cents));
}

export interface CardHeadroom {
  limit_cents: number;
  used_cents: number;
  posted_cents: number;   // charges posted since the last statement closed
  pending_cents: number;  // authorizations not posted yet (from the last PaymentNet check)
  cycle_start: string | null;
  basis: BalanceEntry | null;
  remaining_cents: number;
  fraction_used: number;
  level: "ok" | "warn" | "danger";
}

/** Net charges posted in the current cycle (after the last statement closed). */
export function cycleCharges(txns: Txn[], card: Account, after: string | null, asOf: string): number {
  return 0 - sum(forAccount(txns, card.id)
    .filter((t) => !isTransfer(t) && (after === null || t.date > after) && t.date <= asOf)
    .map((t) => t.amount_cents));
}

/**
 * How much of this cycle's limit is used. The SAE card has a per-cycle limit
 * that resets when each statement closes; the bill is taken from checking
 * weeks later, but that doesn't use up the next cycle's limit. So
 *   used = charges posted since the last statement closed + pending authorizations.
 * Pending authorizations only show in PaymentNet, so they come from the latest
 * "available credit" an exec typed in during this cycle.
 */
export function cardHeadroom(txns: Txn[], card: Account, asOf: string, closings: string[] = [], entries: BalanceEntry[] = []): CardHeadroom {
  const limit = card.credit_limit_cents ?? 0;
  const start = closings.filter((d) => d <= asOf).sort().at(-1) ?? null;
  const posted = cycleCharges(txns, card, start, asOf);
  const basis = latestOf(entries.filter((e) => e.account_id === card.id && e.measure === "available_credit"
    && e.as_of <= asOf && (start === null || e.as_of > start)));
  const pending = basis ? Math.max(0, limit - basis.balance_cents - cycleCharges(txns, card, start, basis.as_of)) : 0;
  const used = posted + pending;
  const fraction = limit ? used / limit : 0;
  return {
    limit_cents: limit, used_cents: used, posted_cents: posted, pending_cents: pending, cycle_start: start, basis,
    remaining_cents: limit - used, fraction_used: fraction,
    level: fraction >= CARD_DANGER_FRACTION ? "danger" : fraction >= CARD_WARN_FRACTION ? "warn" : "ok",
  };
}

// ------------------------------------------------------------- checking

export function latestBalance(entries: BalanceEntry[], accountId: number, asOf: string): BalanceEntry | null {
  return latestOf(entries.filter((e) => e.account_id === accountId && e.as_of <= asOf && e.measure === "balance"));
}

/** Last entered balance plus logged movements since that entry. */
export function projectedBankBalance(txns: Txn[], entries: BalanceEntry[], account: Account, asOf: string): { balance: number | null; basis: BalanceEntry | null } {
  const basis = latestBalance(entries, account.id, asOf);
  if (!basis) return { balance: null, basis: null };
  const moved = sum(forAccount(txns, account.id).filter((t) => {
    const d = bankEffectiveDate(t);
    return d !== null && basis.as_of < d && d <= asOf;
  }).map((t) => t.amount_cents));
  return { balance: basis.balance_cents + moved, basis };
}

export function outstandingChecks(txns: Txn[], account: Account, asOf: string): Txn[] {
  return forAccount(txns, account.id).filter((t) =>
    t.kind === "check" && t.date <= asOf && (t.cleared_date === null || t.cleared_date > asOf));
}

export interface AvailableSummary {
  as_of: string;
  bank_balance_cents: number | null;
  bank_balance_basis: BalanceEntry | null;
  card_owed_cents: number;
  card_pending_cents: number;
  outstanding_checks_cents: number;
  reimbursements_owed_cents: number;
  reimbursements_missing_amount: number;
  available_cents: number | null;
}

/**
 * Available = bank balance - unpaid card - pending card authorizations
 *           - uncashed checks - reimbursements owed.
 * Only confirmed balances are used: a guessed balance must never drive what
 * the team thinks it can spend.
 */
export function available(txns: Txn[], entries: BalanceEntry[], reimbs: Reimbursement[], checking: Account, cards: Account[], asOf: string, closings: Record<number, string[]> = {}): AvailableSummary {
  const { balance, basis } = projectedBankBalance(txns, entries.filter((e) => e.confirmed), checking, asOf);
  const mine = cards.filter((c) => c.paid_from_account_id === checking.id);
  const owed = sum(mine.map((c) => cardOwed(txns, c, asOf)));
  const pending = sum(mine.map((c) => cardHeadroom(txns, c, asOf, closings[c.id] ?? [], entries).pending_cents));
  const checks = 0 - sum(outstandingChecks(txns, checking, asOf).map((t) => t.amount_cents));
  const unpaid = reimbs.filter(isOwed);
  const reimb = sum(unpaid.map((r) => r.amount_cents ?? 0));
  return {
    as_of: asOf, bank_balance_cents: balance, bank_balance_basis: basis, card_owed_cents: owed, card_pending_cents: pending,
    outstanding_checks_cents: checks, reimbursements_owed_cents: reimb,
    reimbursements_missing_amount: unpaid.filter((r) => r.amount_cents === null).length,
    available_cents: balance === null ? null : balance - owed - pending - checks - reimb,
  };
}

// -------------------------------------------------------- reconciliation

export interface ReconRow {
  account_id: number;
  entry: BalanceEntry;
  previous: BalanceEntry | null;
  computed_cents: number | null;    // previous entry + logged movements
  difference_cents: number | null;  // entered - computed; 0 = everything accounted for
}

/** Accounts whose every movement reaches the ledger. */
export const RECONCILED_KINDS: ReadonlySet<AccountKind> = new Set(["checking", "credit_card"]);

/**
 * Compare each entered balance with the one computed from the previous entry
 * plus everything logged in between. A later entry on the same day replaces an
 * earlier one (a correction). Card balances are the amount owed (positive).
 */
export function reconcile(txns: Txn[], entries: BalanceEntry[], account: Account): ReconRow[] {
  if (!RECONCILED_KINDS.has(account.kind)) return [];
  const perDay = new Map<string, BalanceEntry>();
  for (const e of entries
    .filter((e) => e.account_id === account.id && e.measure === "balance" && e.confirmed)
    .sort((a, b) => (a.as_of === b.as_of ? a.id - b.id : a.as_of < b.as_of ? -1 : 1))) perDay.set(e.as_of, e);
  const mine = [...perDay.keys()].sort().map((d) => perDay.get(d)!);
  const acct = forAccount(txns, account.id);
  return mine.map((e, i) => {
    const prev = i ? mine[i - 1]! : null;
    if (account.kind === "credit_card") {
      const computed = 0 - sum(acct.filter((t) => t.date <= e.as_of).map((t) => t.amount_cents));
      return { account_id: account.id, entry: e, previous: prev, computed_cents: computed, difference_cents: e.balance_cents - computed };
    }
    if (!prev) return { account_id: account.id, entry: e, previous: null, computed_cents: null, difference_cents: null };
    const moved = sum(acct.filter((t) => {
      const d = bankEffectiveDate(t);
      return d !== null && prev.as_of < d && d <= e.as_of;
    }).map((t) => t.amount_cents));
    const computed = prev.balance_cents + moved;
    return { account_id: account.id, entry: e, previous: prev, computed_cents: computed, difference_cents: e.balance_cents - computed };
  });
}

// ------------------------------------------------------------- running

/** Running total per account in date order, keyed by transaction id. */
export function runningBalances(txns: Txn[]): Map<number, number> {
  const out = new Map<number, number>();
  const totals = new Map<number, number>();
  for (const t of [...txns].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1))) {
    const v = (totals.get(t.account_id) ?? 0) + t.amount_cents;
    totals.set(t.account_id, v);
    out.set(t.id, v);
  }
  return out;
}

/**
 * Running balance per transaction as the bank would show it: for bank and
 * holding accounts, anchored to the earliest confirmed balance (usually the
 * first statement's opening balance) instead of starting from zero. Cards keep
 * the plain running total (minus the amount owed).
 */
export function anchoredRunning(txns: Txn[], accounts: Account[], entries: BalanceEntry[]): Map<number, number> {
  const raw = runningBalances(txns);
  const out = new Map(raw);
  for (const a of accounts) {
    if (a.kind === "credit_card") continue;
    const first = entries.filter((e) => e.account_id === a.id && e.measure === "balance" && e.confirmed)
      .sort((x, y) => (x.as_of === y.as_of ? x.id - y.id : x.as_of < y.as_of ? -1 : 1))[0];
    if (!first) continue;
    const before = txns.filter((t) => t.account_id === a.id && t.date <= first.as_of)
      .sort((x, y) => (x.date === y.date ? x.id - y.id : x.date < y.date ? -1 : 1)).at(-1);
    const offset = first.balance_cents - (before ? raw.get(before.id)! : 0);
    for (const t of txns) if (t.account_id === a.id) out.set(t.id, raw.get(t.id)! + offset);
  }
  return out;
}

// ------------------------------------------------------------ spending

/** Key for spending per car + subteam; car null = whole team. */
export const spendKey = (projectId: string | null, subteamId: string) => `${projectId ?? "team"}|${subteamId}`;

/**
 * Net spending (positive cents) per car + subteam. Transfers never count;
 * deposits are income, not negative spending; card credits and refunds reduce
 * spend. Unassigned spending is reported under "unassigned|<category>".
 */
export function spendBySubteam(txns: Txn[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string, v: number) => out.set(k, (out.get(k) ?? 0) + v);
  for (const t of txns) {
    if (t.status !== "posted" || !(isSpend(t) || t.kind === "credit")) continue;
    const net = -t.amount_cents;
    if (!t.txn_allocations.length) { add(`unassigned|${t.category}`, net); continue; }
    const sign = net >= 0 ? 1 : -1;
    for (const a of t.txn_allocations) add(spendKey(a.project_id, a.subteam_id), sign * a.amount_cents);
  }
  return out;
}

/** Split total in proportion to weights so the parts sum exactly. */
export function splitEvenly(total: number, weights: number[]): number[] {
  const wsum = sum(weights);
  if (wsum === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / wsum));
  let remainder = total - sum(parts);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (remainder <= 0) break; parts[i]! += 1; remainder -= 1; }
  return parts;
}
