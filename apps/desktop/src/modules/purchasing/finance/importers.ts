// Uploaded CSV files -> ledger lines, ready to preview and import. Pure
// functions: nothing here touches Supabase or React (tests in
// __tests__/importers.test.ts).
//
// Supported: Chase checking and Chase card CSV exports, Square's Transactions
// export (dues and sales), a list of invoices, and any other bank CSV with a
// column mapping. Every line is checked against what's already in the ledger
// (a statement PDF may already have brought it in), so nothing counts twice.

import { parseCents } from "../lib/money";
import type { Account, Txn, TxnKind } from "./ledger";

export type Format = "chase-checking" | "chase-card" | "square" | "invoices" | "generic";
export const FORMAT_LABEL: Record<Format, string> = {
  "chase-checking": "Chase checking export",
  "chase-card": "Chase card export",
  square: "Square transactions export",
  invoices: "List of invoices / receipts",
  generic: "Other bank CSV (pick the columns)",
};

const h = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();
const col = (headers: string[], ...names: string[]) => {
  const H = headers.map(h);
  for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; }
  return -1;
};

export function detectFormat(headers: string[]): Format {
  const H = headers.map(h);
  const has = (...xs: string[]) => xs.every((x) => H.includes(x));
  if (has("details", "posting date", "description", "amount", "balance")) return "chase-checking";
  if (has("transaction date", "post date", "description", "amount")) return "chase-card";
  if (H.includes("gross sales") && (H.includes("net total") || H.includes("total collected"))) return "square";
  if (H.some((x) => ["vendor", "merchant", "supplier"].includes(x)) && H.some((x) => ["total", "amount", "invoice total"].includes(x))) return "invoices";
  return "generic";
}

/** "09/17/2026", "9/17/26", "2026-09-17", "Sep 17, 2026" -> "2026-09-17". */
export function isoDate(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** One line read from a bank or Square file, before deciding what it is. */
export interface Line {
  n: number;                  // row number in the file (for the preview)
  date: string;
  post_date: string | null;
  amount_cents: number;       // negative = money leaving the account
  description: string;
  reference: string | null;   // check number, order number
  type: string;               // the bank's own type (ACH_DEBIT, CHECK_PAID, Sale, Payment...)
  balance_cents: number | null;
  external_id: string | null; // Square transaction id
  fee_of?: number;            // Square: the payment line this fee belongs to
}

export function parseChaseChecking(m: string[][]): Line[] {
  const [hd = [], ...rows] = m;
  const c = { details: col(hd, "details"), date: col(hd, "posting date"), desc: col(hd, "description"), amt: col(hd, "amount"),
    type: col(hd, "type"), bal: col(hd, "balance"), check: col(hd, "check or slip #", "check or slip") };
  return rows.flatMap((r, i) => {
    const date = isoDate(r[c.date]); const amt = parseCents(r[c.amt]);
    if (!date || amt === null) return [];
    const type = (r[c.type] || r[c.details] || "").toUpperCase();
    return [{ n: i + 2, date, post_date: date, amount_cents: amt, description: r[c.desc] ?? "", reference: (r[c.check] ?? "").trim() || null,
      type: (r[c.details] ?? "").toUpperCase() === "CHECK" ? "CHECK_PAID" : type, balance_cents: parseCents(r[c.bal]), external_id: null }];
  });
}

export function parseChaseCard(m: string[][]): Line[] {
  const [hd = [], ...rows] = m;
  const c = { date: col(hd, "transaction date"), post: col(hd, "post date"), desc: col(hd, "description"), type: col(hd, "type"), amt: col(hd, "amount") };
  return rows.flatMap((r, i) => {
    const date = isoDate(r[c.date]); const amt = parseCents(r[c.amt]);
    if (!date || amt === null) return [];
    return [{ n: i + 2, date, post_date: isoDate(r[c.post]), amount_cents: amt, description: r[c.desc] ?? "", reference: null,
      type: r[c.type] ?? "", balance_cents: null, external_id: null }];
  });
}

/** Square: each payment is money in; its processing fee is a separate line. */
export function parseSquare(m: string[][]): Line[] {
  const [hd = [], ...rows] = m;
  const c = { date: col(hd, "date"), total: col(hd, "total collected"), gross: col(hd, "gross sales"), fees: col(hd, "fees"),
    id: col(hd, "transaction id", "payment id"), who: col(hd, "customer name"), desc: col(hd, "description", "details", "item"),
    event: col(hd, "event type") };
  const out: Line[] = [];
  rows.forEach((r, i) => {
    const date = isoDate(r[c.date]);
    const total = parseCents(r[c.total >= 0 ? c.total : c.gross]);
    if (!date || total === null || total === 0) return;
    const id = (r[c.id] ?? "").trim() || null;
    const refund = /refund/i.test(r[c.event] ?? "");
    const what = [r[c.who], r[c.desc]].map((x) => (x ?? "").trim()).filter(Boolean).join(": ");
    const n = i + 2;
    out.push({ n, date, post_date: date, amount_cents: refund ? -Math.abs(total) : total, description: `Square ${refund ? "refund" : "payment"}${what ? ` (${what})` : ""}`,
      reference: id, type: refund ? "Refund" : "Payment", balance_cents: null, external_id: id });
    const fee = parseCents(r[c.fees]);
    if (fee) out.push({ n, date, post_date: date, amount_cents: -Math.abs(fee), description: "Square processing fee", reference: id, type: "Fee",
      balance_cents: null, external_id: id ? `${id}:fee` : null, fee_of: n });
  });
  return out;
}

export interface GenericMap { date: number; amount: number; debit: number; credit: number; description: number; reference: number; balance: number; flip: boolean }

/** Any other bank CSV: the exec says which column is which. */
export function parseGeneric(m: string[][], map: GenericMap, hasHeader = true): Line[] {
  const rows = hasHeader ? m.slice(1) : m;
  return rows.flatMap((r, i) => {
    const date = isoDate(r[map.date]);
    let amt: number | null = null;
    if (map.amount >= 0) amt = parseCents(r[map.amount]);
    else {
      const d = parseCents(r[map.debit]); const cr = parseCents(r[map.credit]);
      if (d !== null || cr !== null) amt = (cr ? Math.abs(cr) : 0) - (d ? Math.abs(d) : 0);
    }
    if (!date || amt === null || amt === 0) return [];
    return [{ n: i + (hasHeader ? 2 : 1), date, post_date: date, amount_cents: map.flip ? -amt : amt, description: r[map.description] ?? "",
      reference: map.reference >= 0 ? (r[map.reference] ?? "").trim() || null : null, type: "", balance_cents: map.balance >= 0 ? parseCents(r[map.balance]) : null,
      external_id: null }];
  });
}

export function guessGenericMap(headers: string[]): GenericMap {
  return {
    date: col(headers, "date", "transaction date", "posting date", "post date", "posted date"),
    amount: col(headers, "amount", "transaction amount"),
    debit: col(headers, "debit", "withdrawals", "withdrawal", "charges"),
    credit: col(headers, "credit", "deposits", "deposit", "payments"),
    description: col(headers, "description", "merchant", "merchant name", "payee", "name", "memo"),
    reference: col(headers, "reference", "check number", "check #", "ref"),
    balance: col(headers, "balance", "running balance"),
    flip: false,
  };
}

// ------------------------------------------------------------- vendors

export interface VendorRule { name: string; aliases: string[]; merchant_pattern: string; default_category: string; review_note: string }

export function matchVendor(text: string, rules: VendorRule[]): VendorRule | null {
  const t = text.toLowerCase();
  for (const r of rules) {
    if (r.merchant_pattern) {
      try { if (new RegExp(r.merchant_pattern, "i").test(text)) return r; } catch { /* a bad pattern never blocks an import */ }
    }
  }
  return rules.find((r) => [r.name, ...r.aliases].some((a) => a.length > 2 && t.includes(a.toLowerCase()))) ?? null;
}

/** "TPM Breaks" -> "TBM Brakes"; unknown names come back as typed. */
export function normalizeVendor(name: string, rules: VendorRule[]): string {
  const n = name.trim().toLowerCase();
  if (!n) return name;
  return rules.find((r) => r.name.toLowerCase() === n || r.aliases.some((a) => a.toLowerCase() === n))?.name ?? name.trim();
}

// ------------------------------------------------------------ planning

export interface NewTxn {
  account_id: number; date: string; post_date: string | null; cleared_date: string | null; amount_cents: number;
  description: string; vendor: string | null; kind: TxnKind; category: string; reference: string | null;
  status: "posted" | "expected"; transfer_group: string | null; needs_review: boolean; review_note: string;
  source: string; source_key: string; notes: string;
}

export type Action = "add" | "duplicate" | "clears-check" | "confirms-autopay";
export interface PlannedLine {
  line: Line;
  action: Action;
  txn: NewTxn;           // what would be added (for "add"; shown for the others)
  why: string;           // plain-English reason for the action
  matchId?: number;      // the ledger line it duplicates or clears
  group?: string;        // the expected transfer it confirms
  amount_cents?: number; // what was actually paid, when it differs from the expected transfer
  pair?: NewTxn;         // the other half of a transfer (Square payout on the Square account)
}

export interface Plan {
  format: Format;
  account: Account;
  lines: PlannedLine[];
  balances: { account_id: number; as_of: string; balance_cents: number; note: string; source_key: string }[];
  statement: { account_id: number; period_start: string | null; closing_date: string; net_charges_cents: number;
    purchases_cents: number; credits_cents: number } | null;
  extra: NewTxn[];       // expected card autopay for a card statement, Square counterparts of earlier payouts
}

export interface PlanOptions {
  fileName: string;
  rules: VendorRule[];
  accounts: Account[];
  existing: Txn[];
  squareCategory?: string;                      // Dues, Merch & website sales...
  cardStatement?: { periodStart: string | null; closing: string } | null;
  /** Where the lines came from, when it isn't the CSV format itself ("chase-card-pdf"). */
  source?: string;
}

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
function hashText(s: string): string {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0).toString(36);
}

interface Decision { kind: TxnKind; category: string; vendor: string | null; description: string; review: string; transfer?: "card" | "square" }

export function classifyChecking(l: Line, rules: VendorRule[]): Decision {
  const d = l.description;
  if (/autopay|comm card|payment to chase card|chase credit crd|epay/i.test(d) && l.amount_cents < 0)
    return { kind: "transfer", category: "Transfer: card payment", vendor: "Chase card autopay", description: "SAE card autopay", review: "", transfer: "card" };
  if (/square/i.test(d) && l.amount_cents > 0)
    return { kind: "transfer", category: "Transfer: between accounts", vendor: "Square", description: "Square payout (dues and sales held in Square)", review: "", transfer: "square" };
  if (/venmo/i.test(d))
    return { kind: l.amount_cents < 0 ? "withdrawal" : "deposit", category: "Needs category", vendor: "Venmo", description: "Venmo payment",
      review: "Paid through Venmo. Who and what for (a reimbursement?)" };
  if (/gofundme/i.test(d)) return { kind: "deposit", category: "Donation / sponsorship", vendor: "GoFundMe", description: "GoFundMe payout", review: "" };
  if (/woopayments|woocommerce|stripe/i.test(d) && l.amount_cents > 0)
    return { kind: "deposit", category: "Merch & website sales", vendor: "Website", description: "Website sales payout", review: "" };
  if (l.type === "CHECK_PAID" || /^check\b/i.test(d))
    return { kind: "check", category: "Needs category", vendor: null, description: `Check ${l.reference ?? ""}`.trim(), review: "Check cleared. What was it for?" };
  if (l.amount_cents > 0) {
    const branch = /deposit/i.test(d);
    return { kind: "deposit", category: "Needs category", vendor: null, description: d.slice(0, 120),
      review: branch ? "Deposit at the bank: dues, a sponsor check, or cash?" : "Money in: what was it?" };
  }
  const v = matchVendor(d, rules);
  return { kind: "withdrawal", category: v?.default_category ?? "Needs category", vendor: v?.name ?? null, description: d.slice(0, 120),
    review: v ? v.review_note : "Not recognised: set a category" };
}

export function classifyCard(l: Line, rules: VendorRule[]): Decision {
  const d = l.description;
  if (/payment/i.test(l.type) || (l.amount_cents > 0 && /payment|autopay|thank you/i.test(d)))
    return { kind: "transfer", category: "Transfer: card payment", vendor: "Chase card autopay", description: "Card payment from checking", review: "", transfer: "card" };
  const v = matchVendor(d, rules);
  if (/fee/i.test(l.type)) return { kind: "fee", category: "Bank fees", vendor: v?.name ?? null, description: d, review: "" };
  if (l.amount_cents > 0) return { kind: "credit", category: v?.default_category ?? "Refund", vendor: v?.name ?? null, description: d, review: "" };
  return { kind: "charge", category: v?.default_category ?? "Needs category", vendor: v?.name ?? null, description: d, review: v?.review_note ?? "" };
}

/** Decide, line by line, what an uploaded file adds to the ledger. */
/** Do two bank descriptions name the same merchant? (a shared word of 4+ letters, ignoring bank noise) */
const NOISE = new Set(["card", "purchase", "debit", "credit", "payment", "online", "transfer", "chase", "recurring", "with", "from"]);
export function sameMerchant(a: string, b: string): boolean {
  const words = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !NOISE.has(w) && !/^\d+$/.test(w)));
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w)) return true;
  return false;
}

export function planImport(format: Format, lines: Line[], account: Account, o: PlanOptions): Plan {
  const used = new Set<number>();
  const mine = o.existing.filter((t) => t.account_id === account.id);
  const squareAcct = o.accounts.find((a) => /square/i.test(a.name) && a.kind === "holding") ?? null;
  const seen = new Map<string, number>();
  const plan: Plan = { format, account, lines: [], balances: [], statement: null, extra: [] };
  // A statement PDF and a CSV export of the same account describe the same
  // lines with different keys, so each gets its own source and key prefix.
  const source = o.source ?? format;
  const keyPrefix = `${source}:${account.id}:`;

  for (const l of lines) {
    const card = format === "chase-card" || (format === "generic" && account.kind === "credit_card");
    const dec: Decision = format === "square"
      ? l.type === "Fee"
        ? { kind: "fee", category: "Bank fees", vendor: "Square", description: l.description, review: "" }
        : { kind: l.amount_cents < 0 ? "withdrawal" : "deposit", category: o.squareCategory || "Dues", vendor: "Square", description: l.description, review: "" }
      : card ? classifyCard(l, o.rules) : classifyChecking(l, o.rules);

    const sig = `${l.date}|${l.amount_cents}|${l.description}`;
    const k = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, k);
    const source_key = l.external_id ? `${keyPrefix}${l.external_id}` : `${keyPrefix}${l.date}:${l.amount_cents}:${hashText(l.description)}:${k}`;
    const txn: NewTxn = {
      account_id: account.id, date: l.date, post_date: l.post_date, cleared_date: dec.kind === "check" ? l.date : l.post_date ?? l.date,
      amount_cents: l.amount_cents, description: dec.description, vendor: dec.vendor, kind: dec.kind, category: dec.category,
      reference: l.reference, status: "posted", transfer_group: null, needs_review: !!dec.review, review_note: dec.review,
      source, source_key, notes: `From ${o.fileName}${l.description && l.description !== dec.description ? `: ${l.description}` : ""}`,
    };

    // a check written in Helios that has now cleared
    if (dec.kind === "check") {
      const open = mine.find((t) => t.kind === "check" && !t.cleared_date && !used.has(t.id) && t.amount_cents === l.amount_cents
        && (!l.reference || !t.reference || t.reference === l.reference));
      if (open) {
        used.add(open.id);
        plan.lines.push({ line: l, action: "clears-check", txn, matchId: open.id, why: `Clears check ${open.reference ?? ""} already in the ledger` });
        continue;
      }
    }
    // a card payment the ledger was expecting
    if (dec.transfer === "card") {
      const waiting = mine.filter((t) => t.kind === "transfer" && t.status === "expected" && t.transfer_group?.startsWith("autopay:") && !used.has(t.id)
        && Math.sign(t.amount_cents) === Math.sign(l.amount_cents) && days(t.date, l.date) <= 45);
      // the exact amount first; otherwise the one expected autopay in the window,
      // taking the amount actually paid (it can differ from the statement by a
      // late charge or a partial payment). Leaving it "expected" would count
      // the payment twice once its due date passes.
      const expected = waiting.find((t) => t.amount_cents === l.amount_cents) ?? (waiting.length === 1 ? waiting[0] : undefined);
      if (expected) {
        used.add(expected.id);
        const differs = expected.amount_cents !== l.amount_cents;
        plan.lines.push({ line: l, action: "confirms-autopay", txn, group: expected.transfer_group!, matchId: expected.id,
          amount_cents: differs ? Math.abs(l.amount_cents) : undefined,
          why: differs
            ? `Confirms the card autopay the ledger was expecting (expected ${(Math.abs(expected.amount_cents) / 100).toFixed(2)}, paid ${(Math.abs(l.amount_cents) / 100).toFixed(2)})`
            : "Confirms the card autopay the ledger was expecting" });
        continue;
      }
    }
    // already in the ledger from another source (a statement PDF, a CSV, the
    // old ledger, or typed in). A line keyed by this same source and scheme
    // is matched exactly by source_key on the server, so a near match there is
    // a different purchase that happens to cost the same (two $25.00 charges on
    // nearby days) and must not be skipped. Across sources the dates may drift
    // a few days; the descriptions must agree too.
    const sameScheme = (t: Txn) => t.source === source && (t.source_key ?? "").startsWith(keyPrefix);
    const dup = mine.find((t) => !used.has(t.id) && !sameScheme(t) && t.amount_cents === l.amount_cents
      && [t.date, t.post_date].some((d) => d && [l.date, l.post_date].some((e) => e && days(d, e) <= 3))
      && (t.date === l.date || sameMerchant(t.description || t.vendor || "", `${l.description} ${dec.vendor ?? ""}`)));
    if (dup) {
      used.add(dup.id);
      plan.lines.push({ line: l, action: "duplicate", txn, matchId: dup.id, why: "Already in the ledger" });
      continue;
    }
    const planned: PlannedLine = { line: l, action: "add", txn, why: dec.review || "New" };
    if (dec.transfer === "square") {
      txn.transfer_group = `square-payout:${l.date}:${l.amount_cents}`;
      if (squareAcct) planned.pair = { ...txn, account_id: squareAcct.id, amount_cents: -l.amount_cents, source_key: `${source_key}:square-side`,
        description: "Payout to Chase", notes: `Other half of the Chase deposit on ${l.date}` };
    } else if (dec.transfer === "card") {
      txn.transfer_group = `card-payment:${l.date}:${Math.abs(l.amount_cents)}`;
    }
    plan.lines.push(planned);
  }

  // Chase checking: the bank's own end-of-day balance, for reconciliation
  if (format === "chase-checking" || format === "generic") {
    const byDay = new Map<string, number>();
    for (const l of lines) if (l.balance_cents !== null && !byDay.has(l.date)) byDay.set(l.date, l.balance_cents); // newest row first
    for (const [as_of, balance_cents] of byDay) {
      plan.balances.push({ account_id: account.id, as_of, balance_cents, note: `End of day balance from ${o.fileName}`, source_key: `bank-balance:${account.id}:${as_of}` });
    }
  }

  // a card statement: record its closing (it resets the cycle limit) and the autopay it will trigger
  if (account.kind === "credit_card" && o.cardStatement?.closing) {
    const { periodStart, closing } = o.cardStatement;
    const inPeriod = lines.filter((l) => (!periodStart || l.date >= periodStart) && l.date <= closing);
    const spend = inPeriod.filter((l) => !(classifyCard(l, o.rules).transfer)).reduce((s, l) => s - l.amount_cents, 0);
    const purchases = inPeriod.filter((l) => l.amount_cents < 0 && !classifyCard(l, o.rules).transfer).reduce((s, l) => s - l.amount_cents, 0);
    plan.statement = { account_id: account.id, period_start: periodStart, closing_date: closing, net_charges_cents: spend,
      purchases_cents: purchases, credits_cents: purchases - spend };
    const group = `autopay:${account.last4 ?? account.id}:${closing}`;
    const checking = o.accounts.find((a) => a.id === account.paid_from_account_id);
    if (checking && spend > 0 && !o.existing.some((t) => t.transfer_group === group)) {
      const due = addDays(closing, 28);
      const base = { date: due, post_date: null, cleared_date: null, description: `Card autopay for statement closing ${closing}`, vendor: "Chase card autopay",
        kind: "transfer" as TxnKind, category: "Transfer: card payment", reference: null, status: "expected" as const, transfer_group: group,
        needs_review: false, review_note: "", source: format, notes: "Expected about 28 days after the statement closes; replaced when checking shows it." };
      plan.extra.push({ ...base, account_id: checking.id, amount_cents: -spend, source_key: `${group}:checking` });
      plan.extra.push({ ...base, account_id: account.id, amount_cents: spend, source_key: `${group}:card` });
    }
  }

  // Square: earlier payouts into Chase need their Square-side half
  if (format === "square" && lines.length) {
    const first = lines.reduce((m, l) => (l.date < m ? l.date : m), lines[0]!.date);
    for (const t of o.existing) {
      if (t.kind !== "transfer" || t.amount_cents <= 0 || !/square/i.test(`${t.vendor} ${t.description}`) || t.date < first) continue;
      const hasPair = o.existing.some((x) => x.id !== t.id && x.account_id === account.id && x.kind === "transfer"
        && x.amount_cents === -t.amount_cents && (x.transfer_group === t.transfer_group || days(x.date, t.date) <= 3));
      if (!hasPair) {
        plan.extra.push({
          account_id: account.id, date: t.date, post_date: t.date, cleared_date: t.date, amount_cents: -t.amount_cents,
          description: "Payout to Chase", vendor: "Square", kind: "transfer", category: "Transfer: between accounts", reference: null,
          status: "posted", transfer_group: t.transfer_group ?? `square-payout:${t.date}:${t.amount_cents}`, needs_review: false,
          review_note: "", source: "square", source_key: `square-payout-pair:${t.id}`, notes: `Other half of Chase deposit #${t.id}`,
        });
      }
    }
  }
  return plan;
}

// ------------------------------------------------------------ invoices

export interface InvoiceLine { n: number; vendor: string; date: string | null; total_cents: number | null; order_ref: string | null; items: string }

export function parseInvoices(m: string[][], rules: VendorRule[]): InvoiceLine[] {
  const [hd = [], ...rows] = m;
  const c = { vendor: col(hd, "vendor", "merchant", "supplier", "store"), date: col(hd, "date", "order date", "invoice date", "paid date"),
    total: col(hd, "total", "amount", "invoice total", "amount paid", "grand total"),
    ref: col(hd, "order #", "order", "order number", "invoice #", "invoice number", "po", "po number", "receipt #", "reference"),
    items: col(hd, "items", "description", "item", "what")};
  return rows.flatMap((r, i) => {
    const vendor = normalizeVendor(r[c.vendor] ?? "", rules);
    if (!vendor) return [];
    return [{ n: i + 2, vendor, date: isoDate(r[c.date]), total_cents: parseCents(r[c.total]), order_ref: (r[c.ref] ?? "").trim() || null, items: r[c.items] ?? "" }];
  });
}

/** The one charge an invoice most likely paid for: same amount, dated from 3 days before to 10 after, vendor if known. */
export function matchInvoice(inv: InvoiceLine, txns: Txn[], taken: Set<number>, rules: VendorRule[]): Txn | null {
  if (inv.total_cents === null) return null;
  const cands = txns.filter((t) => !taken.has(t.id) && ["charge", "withdrawal", "check"].includes(t.kind) && -t.amount_cents === inv.total_cents
    && (!inv.date || (Date.parse(t.date) - Date.parse(inv.date) >= -3 * 86_400_000 && Date.parse(t.date) - Date.parse(inv.date) <= 10 * 86_400_000)));
  const byVendor = cands.filter((t) => t.vendor && normalizeVendor(t.vendor, rules).toLowerCase() === inv.vendor.toLowerCase());
  const pick = byVendor.length === 1 ? byVendor[0] : cands.length === 1 ? cands[0] : null;
  return pick ?? null;
}

/** A file's fingerprint, so the same file is never imported twice. */
export async function sha256(content: string | ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", typeof content === "string" ? new TextEncoder().encode(content) : content);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
