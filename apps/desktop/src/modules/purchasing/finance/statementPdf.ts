// Chase statement PDFs -> ledger lines. Ported from the standalone ledger's
// readers (sdm/importers/chase_card_pdf.py, chase_checking_pdf.py).
//
// The PDFs' text comes out with amounts on the wrong lines if read naively,
// so rows are rebuilt from each word's position on the page. Every statement
// is checked against its own printed totals; if anything doesn't add up the
// import is refused instead of loading wrong numbers. Only the last four
// digits of a card or account number are kept.
//
// Pure functions over positioned words (tests in __tests__/statementPdf.test.ts);
// pdfWords() is the only part that touches PDF.js.

import { parseCents } from "../lib/money";
import type { Line } from "./importers";

export interface Word { text: string; x: number; top: number }
export class StatementError extends Error {}

/** Group words into visual rows (same baseline within 2pt), left to right. */
export function rows(words: Word[]): Word[][] {
  const out: Word[][] = [];
  for (const w of [...words].sort((a, b) => Math.round(a.top) - Math.round(b.top) || a.x - b.x)) {
    const last = out.at(-1);
    if (last && Math.abs(last[0]!.top - w.top) <= 2) last.push(w);
    else out.push([w]);
  }
  return out.map((r) => r.sort((a, b) => a.x - b.x));
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const text = (r: Word[]) => r.map((w) => w.text).join(" ");

// ------------------------------------------------------------------ card

const CARD_DATE = /^\d{2}-\d{2}$/;
const REF = /^\d{15,}$/;
const CARD_MONEY = /^\$?[\d,]*\.\d{2}(CR)?$/;
const CARD_NO = /(\d{4})-(\d{4})-(\d{4})-(\d{4})|XXXX-XX\d{2}-\d{4}-(\d{4})/;

export interface CardLine { post_date: string; txn_date: string; reference: string; description: string; amount_cents: number; section: string; extra: string }
export interface CardStatement {
  closing_date: string; last4: string; cardholder: string; cycle_limit_cents: number | null;
  net_charges_cents: number; purchases_cents: number; credits_cents: number; lines: CardLine[];
}

export function parseCardWords(pages: Word[][]): CardStatement {
  const paged = pages.flatMap((p, i) => rows(p).map((r) => ({ page: i, r })));
  const texts = paged.map(({ r }) => text(r));
  const joined = texts.join("\n");
  const m = joined.match(/STATEMENT DATE:?\s*(\d{2})[-/](\d{2})[-/](\d{2})/);
  if (!m) throw new StatementError("No statement date found. Is this a Chase card statement?");
  const cy = 2000 + Number(m[3]), cm = Number(m[1]);
  const closing = iso(cy, cm, Number(m[2]));
  const toDate = (mmdd: string) => { const [mo, d] = mmdd.split("-").map(Number); return iso(mo! <= cm ? cy : cy - 1, mo!, d!); };
  const card = joined.match(CARD_NO);
  const last4 = card ? (card[4] ?? card[5] ?? "") : "";
  const holder = joined.match(/NAME:\s*(.+?)\s+CYCLE/);
  const limit = joined.match(/CYCLE LIMIT:\s*(\$[\d,]+(?:\.\d{2})?)/);

  const summary = (label: string): number => {
    for (let i = 0; i < paged.length; i++) {
      if (!(texts[i]!.startsWith(label) || texts[i]!.includes(` ${label}`))) continue;
      for (const r of [paged[i]!.r, paged[i + 1]?.r ?? []]) {
        const money = r.filter((w) => CARD_MONEY.test(w.text.replace("$", "")) && w.x > 400);
        if (money.length) return parseCents(money.at(-1)!.text)!;
      }
    }
    throw new StatementError(`Couldn't find '${label}' in the account summary`);
  };
  const purchases = summary("OTHER CHARGES"), credits = summary("CREDITS"), net = summary("NET CHARGES");

  let section = "";
  const lines: CardLine[] = [];
  const totals: Record<string, number> = {};
  let last = { page: -1, top: 0 };
  paged.forEach(({ page, r }, i) => {
    const t = texts[i]!;
    const sm = t.match(/^(\w+) Activity$/);
    if (sm && sm[1] !== "CARDHOLDER") { section = sm[1]!; return; }
    const tm = t.match(/^Total (\w+) Activity/);
    if (tm) { totals[tm[1]!] = parseCents(r.at(-1)!.text) ?? 0; return; }
    if (r.length >= 4 && CARD_DATE.test(r[0]!.text) && CARD_DATE.test(r[1]!.text) && REF.test(r[2]!.text)) {
      const amt = r.at(-1)!;
      if (!CARD_MONEY.test(amt.text)) throw new StatementError(`Transaction row without an amount: ${t}`);
      lines.push({ post_date: toDate(r[0]!.text), txn_date: toDate(r[1]!.text), reference: r[2]!.text,
        description: r.slice(3, -1).map((w) => w.text).join(" "), amount_cents: parseCents(amt.text)!, section: section || "Purchasing", extra: "" });
      last = { page, top: r[0]!.top };
      return;
    }
    // continuation lines sit just under their transaction
    if (lines.length && page === last.page && r[0]!.top - last.top > 0 && r[0]!.top - last.top <= 12 && r[0]!.x >= 150) {
      const pos = t.match(/^P\.O\.S\.:\s*(\S+)/);
      if (pos) lines.at(-1)!.reference = pos[1]!;
      else if (!CARD_NO.test(t)) lines.at(-1)!.extra = `${lines.at(-1)!.extra} ${t}`.trim();
    }
  });

  const st: CardStatement = { closing_date: closing, last4, cardholder: holder?.[1]?.trim() ?? "", cycle_limit_cents: limit ? parseCents(limit[1]!) : null,
    net_charges_cents: net, purchases_cents: purchases, credits_cents: credits, lines };
  const problems: string[] = [];
  for (const [sec, total] of Object.entries(totals)) {
    const got = lines.filter((l) => l.section === sec).reduce((s, l) => s + l.amount_cents, 0);
    if (got !== total) problems.push(`${sec} rows add up to ${(got / 100).toFixed(2)}, the statement says ${(total / 100).toFixed(2)}`);
  }
  const charges = lines.filter((l) => l.amount_cents > 0).reduce((s, l) => s + l.amount_cents, 0);
  const cr = -lines.filter((l) => l.amount_cents < 0).reduce((s, l) => s + l.amount_cents, 0);
  if (charges !== purchases) problems.push(`charges add up to ${(charges / 100).toFixed(2)}, the statement says ${(purchases / 100).toFixed(2)}`);
  if (cr !== credits) problems.push(`credits add up to ${(cr / 100).toFixed(2)}, the statement says ${(credits / 100).toFixed(2)}`);
  if (charges - cr !== net) problems.push(`net ${((charges - cr) / 100).toFixed(2)} isn't the statement's ${(net / 100).toFixed(2)}`);
  if (!last4) problems.push("card number not found");
  if (problems.length) throw new StatementError(`This statement doesn't add up, so nothing was imported: ${problems.join("; ")}`);
  return st;
}

/** Card lines in ledger form: charges negative, credits positive. */
export function cardLines(st: CardStatement): Line[] {
  return st.lines.map((l, i) => ({
    n: i + 1, date: l.txn_date, post_date: l.post_date, amount_cents: -l.amount_cents,
    description: `${l.description}${l.extra ? ` ${l.extra}` : ""}`.trim(), reference: l.reference,
    type: l.amount_cents < 0 ? "Return" : "Sale", balance_cents: null, external_id: `${l.post_date}:${l.reference}:${l.amount_cents}`,
  }));
}

// -------------------------------------------------------------- checking

const CHK_DATE = /^\d{2}\/\d{2}$/;
const CHK_MONEY = /^\$?[\d,]*\.\d{2}$/;
const PERIOD = /([A-Z][a-z]+ \d{2}, \d{4}) through ([A-Z][a-z]+ \d{2}, \d{4})/;
const SECTIONS: Record<string, "deposit" | "withdrawal" | "check"> = {
  "Deposits and Credits": "deposit", "Withdrawals and Debits": "withdrawal", "Checks Paid": "check",
};

export interface CheckingLine { date: string; section: "deposit" | "withdrawal" | "check"; amount_cents: number; description: string; detail: string; check_number: string | null }
export interface CheckingStatement {
  period_start: string; period_end: string; last4: string; opening_cents: number; ending_cents: number;
  totals: Record<"deposit" | "withdrawal" | "check", number>; lines: CheckingLine[]; daily_balances: [string, number][];
}

const moneyIn = (r: Word[], lo: number, hi: number) => {
  const v = r.filter((w) => w.x >= lo && w.x <= hi && CHK_MONEY.test(w.text));
  return v.length ? parseCents(v.at(-1)!.text) : null;
};
function longDate(s: string): string {
  const d = new Date(`${s} 12:00`);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function parseCheckingWords(pages: Word[][]): CheckingStatement {
  const paged = pages.flatMap((p, i) => rows(p).map((r) => ({ page: i, r })));
  const texts = paged.map(({ r }) => text(r));
  const m = texts.join("\n").match(PERIOD);
  if (!m) throw new StatementError("No statement period found. Is this a Chase checking statement?");
  const start = longDate(m[1]!), end = longDate(m[2]!);
  const endY = Number(end.slice(0, 4)), endM = Number(end.slice(5, 7));
  const toDate = (mmdd: string) => { const [mo, d] = mmdd.split("/").map(Number); return iso(mo! <= endM ? endY : endY - 1, mo!, d!); };

  // the account number sits beside or just under the 'Account Number:' label, top right
  let last4 = "";
  for (const page of pages) {
    const label = page.find((w) => w.text === "Number:" && w.x > 300);
    const num = label && page.find((w) => w.x > 350 && w.top - label.top >= -8 && w.top - label.top <= 15 && /^\d{6,}$/.test(w.text));
    if (num) { last4 = num.text.slice(-4); break; }
  }

  const summary: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const LABELS: [string, string][] = [["Opening Ledger Balance", "opening"], ["Deposits and Credits", "deposit"],
    ["Withdrawals and Debits", "withdrawal"], ["Checks Paid", "check"], ["Ending Ledger Balance", "ending"]];
  for (let i = 0; i < paged.length && Object.keys(summary).length < 5; i++) {
    const flat = texts[i]!.replace(/ /g, "");
    for (const [label, key] of LABELS) {
      if (key in summary || !flat.includes(label.replace(/ /g, ""))) continue;
      const amount = moneyIn(paged[i]!.r, 380, 460);
      if (amount === null) continue;
      summary[key] = amount;
      const n = paged[i]!.r.find((w) => w.x >= 285 && w.x <= 310 && /^\d+$/.test(w.text));
      if (n) counts[key] = Number(n.text);
    }
  }
  if (Object.keys(summary).length < 5) throw new StatementError("Couldn't read the account summary on the first page.");

  let section: CheckingLine["section"] | null = null;
  let inDaily = false;
  let last: { page: number; top: number } | null = null;
  const lines: CheckingLine[] = [];
  const daily: [string, number][] = [];
  const secTotals: Record<string, number | null> = {};
  paged.forEach(({ page, r }, i) => {
    const t = texts[i]!;
    const head = t.replace(" (continued)", "").replace("(continued) ", "").trim();
    if (SECTIONS[head] && r[0]!.x < 60) { section = SECTIONS[head]!; inDaily = false; last = null; return; }
    if (t.startsWith("Daily Balance")) { section = null; inDaily = true; last = null; return; }
    if (inDaily) {
      const ws = r.map((w) => w.text);
      ws.slice(0, -1).forEach((w, k) => { if (CHK_DATE.test(w) && CHK_MONEY.test(ws[k + 1]!)) daily.push([toDate(w), parseCents(ws[k + 1]!)!]); });
      return;
    }
    if (!section) return;
    if (r[0]!.text === "Total" && r[0]!.x < 60) { secTotals[section] = moneyIn(r, 450, 600); last = null; return; }
    if (CHK_DATE.test(r[0]!.text) && r[0]!.x < 60) {
      const amount = moneyIn(r, 470, 600);
      if (amount === null) throw new StatementError(`Transaction row without an amount: ${t.slice(0, 80)}`);
      const words = r.slice(1).filter((w) => !(w.x >= 470 && CHK_MONEY.test(w.text)));
      const check = section === "check" && words[0] && /^\d+$/.test(words[0].text) ? words[0].text : null;
      lines.push({ date: toDate(r[0]!.text), section, amount_cents: amount, description: words.map((w) => w.text).join(" "), detail: "", check_number: check });
      last = { page, top: r[0]!.top };
      return;
    }
    if (last && page === last.page && r[0]!.top - last.top > 0 && r[0]!.top - last.top <= 60 && r[0]!.x >= 90) {
      lines.at(-1)!.detail = `${lines.at(-1)!.detail} ${t}`.trim();
      last = { page, top: r[0]!.top };
    }
  });

  const totals = { deposit: summary.deposit!, withdrawal: summary.withdrawal!, check: summary.check! };
  const problems: string[] = [];
  for (const [sec, printed] of Object.entries(secTotals)) {
    if (printed !== null && printed !== totals[sec as keyof typeof totals]) problems.push(`${sec} total doesn't match the summary`);
  }
  for (const sec of ["deposit", "withdrawal", "check"] as const) {
    const rs = lines.filter((l) => l.section === sec);
    const got = rs.reduce((s, l) => s + l.amount_cents, 0);
    if (got !== totals[sec]) problems.push(`${sec} rows add up to ${(got / 100).toFixed(2)}, the summary says ${(totals[sec] / 100).toFixed(2)}`);
    if (sec in counts && counts[sec] !== rs.length) problems.push(`${rs.length} ${sec} rows found, the summary says ${counts[sec]}`);
  }
  if (summary.opening! + totals.deposit - totals.withdrawal - totals.check !== summary.ending) problems.push("opening + deposits − withdrawals − checks isn't the ending balance");
  if (daily.length && [...daily].sort().at(-1)![1] !== summary.ending) problems.push("the last daily balance isn't the ending balance");
  if (!last4) problems.push("account number not found");
  if (problems.length) throw new StatementError(`This statement doesn't add up, so nothing was imported: ${problems.join("; ")}`);
  return { period_start: start, period_end: end, last4, opening_cents: summary.opening!, ending_cents: summary.ending!, totals, lines, daily_balances: daily };
}

/** Checking lines in ledger form: deposits positive, withdrawals and checks negative. */
export function checkingLines(st: CheckingStatement): Line[] {
  const seen = new Map<string, number>();
  return st.lines.map((l, i) => {
    const trn = `${l.description} ${l.detail}`.match(/Trn:\s*(\w+)/)?.[1];
    const sig = `${l.date}|${l.section}|${l.amount_cents}|${l.description}`;
    const k = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, k);
    const orig = `${l.description} ${l.detail}`.match(/Orig CO Name:\s*(.+?)(?=\s+(?:Orig ID|Desc Date|CO Entry|Entry Descr|Sec:|Ind ID|Ind Name|Trn:|Eed:)|$)/)?.[1];
    return {
      n: i + 1, date: l.date, post_date: l.date, amount_cents: l.section === "deposit" ? l.amount_cents : -l.amount_cents,
      description: `${orig ? `${orig}: ` : ""}${l.description} ${l.detail}`.trim().slice(0, 300), reference: l.check_number,
      type: l.section === "check" ? "CHECK_PAID" : l.section.toUpperCase(), balance_cents: null,
      external_id: `${l.date}:${trn ?? `${l.section}${l.amount_cents}#${k}`}`,
    };
  });
}

// ---------------------------------------------------------------- PDF.js

/** Positioned words from a PDF, one list per page (in the layout pdfplumber gives). */
export async function pdfWords(data: ArrayBuffer): Promise<Word[][]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: Word[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const height = page.getViewport({ scale: 1 }).height;
    const content = await page.getTextContent();
    const words: Word[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [, , , , x, y] = item.transform as number[];
      const size = Math.hypot(item.transform[2] as number, item.transform[3] as number) || item.height || 10;
      const top = height - (y as number) - size;
      const perChar = item.str.length ? item.width / item.str.length : 0;
      // one text run can hold several words: split on spaces, keep each word's x
      let offset = 0;
      for (const part of item.str.split(/(\s+)/)) {
        if (part.trim()) words.push({ text: part, x: (x as number) + offset * perChar, top });
        offset += part.length;
      }
    }
    pages.push(words);
  }
  return pages;
}

export type PdfKind = "chase-card" | "chase-checking" | "unknown";
export function pdfKind(pages: Word[][]): PdfKind {
  const first = rows(pages[0] ?? []).map(text).join("\n");
  if (/MEMO STATEMENT/i.test(first) && /CARDHOLDER/i.test(first)) return "chase-card";
  if (/Checking/i.test(first) && /Ledger Balance/i.test(first)) return "chase-checking";
  return "unknown";
}
