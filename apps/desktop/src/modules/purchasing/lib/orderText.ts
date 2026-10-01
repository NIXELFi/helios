// Reading an order confirmation (an email, the vendor's order page, or a PDF
// of either) and spreading its shipping, tax and fees over the parts bought
// together. Pure functions, no React.
//
// Members rarely know the tax and often not the shipping when they add a
// part, and one cart usually holds several parts. The confirmation has the
// real figures for the whole cart; each part gets a share in proportion to its
// price, rounded so the shares add up to the cent.

import { parseCents } from "./money";

export interface OrderTotals {
  orderId: string | null;
  date: string | null;          // yyyy-mm-dd
  vendor: string | null;
  subtotal: number | null;      // cents, before shipping/tax
  shipping: number | null;
  tax: number | null;
  fees: number | null;          // tariffs, duties, handling fees, surcharges
  discount: number | null;      // negative
  total: number | null;
}

/** Shipping + tax + fees + discount: what goes on top of the parts' prices. */
export const extrasOf = (o: OrderTotals) => (o.shipping ?? 0) + (o.tax ?? 0) + (o.fees ?? 0) + (o.discount ?? 0);

const MONEY = /(-|−)?\s*\$?\s*(-|−)?\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/;
const amount = (s: string): number | null => {
  const m = s.match(MONEY);
  if (!m) return null;
  const cents = parseCents(`${m[3]}.${m[4]}`);
  return cents === null ? null : (m[1] || m[2] ? -cents : cents);
};

type Field = "subtotal" | "shipping" | "tax" | "fees" | "discount" | "total" | "skip";
// The first pattern that matches a line's label decides what the amount is.
const LABELS: [RegExp, Field][] = [
  [/total before tax|pre-?tax total|tax\s*exempt|taxable|you saved|savings to date|refund|reward|points|balance|per (item|unit)|unit price/i, "skip"],
  [/free shipping|shipping (discount|savings|promotion)/i, "discount"],
  [/discount|promo(tion)?|coupon|savings|gift card/i, "discount"],
  [/sub-?total|merchandise( total)?|items?\s*(\(s\))?\s*total|item\(s\)/i, "subtotal"],
  [/tariff|duty|duties|surcharge|import|(handling|processing|service|environmental|small order|hazmat|cut tape|reel)\s*(fee|charge)|\bfees?\b/i, "fees"],
  [/shipping|freight|delivery|postage|s\s*&\s*h|handling/i, "shipping"],
  [/\btax(es)?\b|\bvat\b|\bgst\b|\bhst\b/i, "tax"],
  [/grand total|order total|total (charged|paid|due|amount)|amount (charged|paid|due)|payment total|invoice total|^\s*total\b/i, "total"],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function findDate(text: string): string | null {
  const near = text.match(/(order(ed)?\s*(placed|date|on)?|placed on|date)\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const raw = near?.[4] ?? text.match(/([A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4})/)?.[1] ?? null;
  if (!raw) return null;
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return raw;
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  const mo = m ? MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) : -1;
  return m && mo >= 0 ? `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
}

function findOrderId(text: string): string | null {
  const m = text.match(/(?:purchase\s+order|web\s+order|sales\s+order|order|invoice|receipt|confirmation)\s*(?:#|number|no\.?|id)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,})/i)
    ?? text.match(/order\s*#?\s*:?\s*(#?[A-Z]?\d[\d-]{3,})/i)
    ?? text.match(/#([A-Z]{0,3}\d{4,})/);
  return m ? m[1]!.replace(/^#/, "") : null;
}

/**
 * Totals from an order confirmation's text. Each line's label decides what its
 * amount is; a label alone on its line takes the amount on the next line (as
 * pages copied from a browser often come out). Anything not found is null.
 */
export function parseOrderText(text: string, vendorNames: string[] = []): OrderTotals {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const found: Partial<Record<Exclude<Field, "skip">, number>> = {};
  let shippingAdj = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const label = line.replace(MONEY, "").trim();
    if (!label || label.length > 60) continue;
    const field = LABELS.find(([re]) => re.test(label))?.[1];
    if (!field || field === "skip") continue;
    let value = amount(line);
    if (value === null && i + 1 < lines.length && lines[i + 1]!.replace(MONEY, "").trim().length <= 2) value = amount(lines[i + 1]!);
    if (value === null) continue;
    if (field === "discount") {
      // "Free Shipping: -$2.96" cancels a shipping charge; any other discount lowers the total
      if (/shipping/i.test(label)) shippingAdj += -Math.abs(value);
      else found.discount = (found.discount ?? 0) - Math.abs(value);
      continue;
    }
    // the last total on the page is the one charged (a "Total" per shipment comes first)
    if (field === "total" || found[field] === undefined) found[field] = value;
  }
  const shipping = found.shipping !== undefined || shippingAdj ? (found.shipping ?? 0) + shippingAdj : null;
  const out: OrderTotals = {
    orderId: findOrderId(text), date: findDate(text),
    vendor: vendorNames.find((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) ?? null,
    subtotal: found.subtotal ?? null, shipping, tax: found.tax ?? null, fees: found.fees ?? null,
    discount: found.discount ?? null, total: found.total ?? null,
  };
  if (out.total === null && out.subtotal !== null) out.total = out.subtotal + extrasOf(out);
  if (out.subtotal === null && out.total !== null && (out.shipping !== null || out.tax !== null)) out.subtotal = out.total - extrasOf(out);
  return out;
}

/**
 * Split `amount` cents over `weights` in proportion, rounding so the parts add
 * up exactly (largest remainder). All-zero weights split evenly.
 */
export function allocate(amount: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? w.map((x) => (amount * x) / sum) : w.map(() => amount / w.length);
  const out = shares.map((s) => Math.trunc(s));
  let left = amount - out.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => ({ i, r: Math.abs(s - Math.trunc(s)) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left !== 0; k = (k + 1) % order.length) {
    const step = Math.sign(left);
    out[order[k]!.i]! += step;
    left -= step;
  }
  return out;
}

export interface CartPart { id: string; price: number }
export interface CartShare { id: string; price: number; extra: number; total: number }

/**
 * Each part's share of an order.
 *  - "whole": these parts are the whole order. The order total is spread over
 *    them by price, so their totals add up to what was charged even if prices
 *    changed since the estimate.
 *  - "share": the order also had things that aren't on the parts list. Each
 *    part keeps its price and gets its fraction of the extras (its price over
 *    the order's subtotal).
 */
export function splitOrder(parts: CartPart[], o: OrderTotals, mode: "whole" | "share"): CartShare[] {
  const prices = parts.map((p) => p.price);
  const extras = extrasOf(o);
  if (mode === "whole") {
    const extra = allocate(extras, prices);
    const totals = o.total !== null ? allocate(o.total, prices) : parts.map((p, k) => p.price + extra[k]!);
    return parts.map((p, k) => ({ id: p.id, price: totals[k]! - extra[k]!, extra: extra[k]!, total: totals[k]! }));
  }
  const base = o.subtotal && o.subtotal > 0 ? o.subtotal : prices.reduce((a, b) => a + b, 0);
  return parts.map((p) => {
    const extra = base > 0 ? Math.round((extras * p.price) / base) : 0;
    return { id: p.id, price: p.price, extra, total: p.price + extra };
  });
}
