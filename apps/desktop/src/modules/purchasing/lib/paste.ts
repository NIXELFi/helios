// Turning a block of cells copied from Excel / Airtable / Google Sheets or a
// Mouser / Digikey cart into purchase rows. Pure functions, no React.

import { parseCents } from "./money";

export type PasteField =
  | "title" | "quantity" | "unit_price" | "tax_shipping" | "total" | "vendor" | "funding_source"
  | "part_number" | "product_url" | "priority" | "needed_by" | "date_needed_raw" | "notes" | "status";

export const PASTE_FIELDS: PasteField[] = [
  "title", "quantity", "unit_price", "tax_shipping", "total", "vendor", "funding_source",
  "part_number", "product_url", "priority", "needed_by", "date_needed_raw", "notes", "status",
];

export const PASTE_LABELS: Record<PasteField, string> = {
  title: "Item", quantity: "Qty", unit_price: "Unit $", tax_shipping: "Tax/ship $", total: "Total $",
  vendor: "Vendor", funding_source: "Funding", part_number: "Part #", product_url: "Link", priority: "Priority",
  needed_by: "Needed by", date_needed_raw: "Date needed (as written)", notes: "Notes", status: "Status",
};

// Header names seen in Airtable, Excel BOMs, Mouser and Digikey cart exports.
// Order matters within a field: earlier names win when two columns match the
// same field (a manufacturer part number beats the distributor's own number,
// because the manufacturer's is what shows up in order emails).
const ALIASES: Record<PasteField, string[]> = {
  title: ["item", "item name", "name", "description", "product", "part description", "component", "title", "product description"],
  quantity: ["qty", "q", "quantity", "order qty", "quantity ordered", "qty ordered", "quantity requested"],
  unit_price: ["unit price", "cost per unit", "price", "unit cost", "unit price usd", "price each", "each", "unit price $", "unit $"],
  tax_shipping: ["tax shipping", "tax and shipping", "shipping", "tax & shipping", "tax ship $"],
  total: ["total", "total cost", "ext price", "extended price", "total price", "ext price usd", "line total", "extended price usd"],
  vendor: ["vendor", "supplier", "distributor", "store"],
  funding_source: ["funding source", "funding", "paid from", "funding account"],
  part_number: ["mfr #", "mfr part #", "mfr part number", "manufacturer part number", "mpn", "part #", "part number",
    "part no", "mouser #", "digi key part number", "digikey part number", "sku", "customer reference"],
  product_url: ["link", "url", "product link", "product url"],
  priority: ["priority"],
  needed_by: ["needed by", "need by", "due", "due date", "need by date"],
  // The team's Airtable "DATE NEEDED" holds request or order dates, not a
  // need-by date, so it's kept as written rather than read as one.
  date_needed_raw: ["date needed"],
  notes: ["notes", "comments", "note"],
  status: ["status"],
};

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9#&$]+/g, " ").replace(/\s+/g, " ").trim();

function guess(header: string): { field: PasteField; rank: number } | null {
  const n = norm(header);
  for (const f of PASTE_FIELDS) {
    const names = ALIASES[f];
    const i = Math.max(names.indexOf(n), names.indexOf(n.replace(/ #$/, "")));
    if (i >= 0) return { field: f, rank: i };
  }
  // Headers drift ("Unit Cost ($)", "Item Name (short)", "Total Cost USD"):
  // failing an exact name, the longest known name inside the header wins.
  // Exact matches still beat these (rank 100+).
  let best: { field: PasteField; rank: number } | null = null;
  let longest = 0;
  for (const f of PASTE_FIELDS) {
    const names = ALIASES[f];
    for (let i = 0; i < names.length; i++) {
      const a = names[i]!;
      if (a.length >= 4 && a.length > longest && ` ${n} `.includes(` ${a} `)) { best = { field: f, rank: 100 + i }; longest = a.length; }
    }
  }
  return best;
}

/** Map a header row to fields; if two columns claim a field, the better-ranked wins. */
export function mapHeaders(headers: string[]): (PasteField | null)[] {
  const g = headers.map(guess);
  return g.map((x, k) => {
    if (!x) return null;
    const beaten = g.some((o, j) => o && j !== k && o.field === x.field && (o.rank < x.rank || (o.rank === x.rank && j < k)));
    return beaten ? null : x.field;
  });
}

/** True if the first row looks like column headers. */
export function looksLikeHeader(row: string[]): boolean {
  return mapHeaders(row).filter(Boolean).length >= 2;
}

/** Parse tab-separated clipboard text the way Excel writes it (quoted cells may hold newlines). */
export function parseTsv(text: string): string[][] {
  return parseDelimited(text, "\t");
}

/** Parse a CSV file (Airtable, bank and Square exports). */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text.replace(/^\uFEFF/, ""), ",");
}

function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { current.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      current.push(cell); cell = ""; rows.push(current); current = [];
    } else cell += ch;
  }
  current.push(cell);
  rows.push(current);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

/** Row shape the add_items RPC takes. */
export interface NewRow {
  title: string;
  quantity?: number;
  unit_price_cents?: number;
  tax_shipping_cents?: number;
  total_estimate_cents?: number;
  vendor?: string;
  part_number?: string;
  product_url?: string;
  priority?: string;
  needed_by?: string;
  notes?: string;
  /** From an Airtable Status column: PLANNED, READY, ORDERED, RECEIVED or HAVE. */
  status?: string;
  /** Airtable's "Funding Source" as written ("Chase Account"). */
  funding_source?: string;
  /** Airtable's "DATE NEEDED" as written (its meaning isn't settled). */
  date_needed_raw?: string;
  /** Where the row came from, e.g. "airtable:IC Team/Aero-Grid view.csv row 4". */
  source?: string;
}

/** Airtable's status words -> the parts list's. */
export const AIRTABLE_STATUS: Record<string, string> = {
  "not ready to order": "PLANNED", "not ready": "PLANNED", planned: "PLANNED", "ready to order": "READY", ready: "READY",
  ordered: "ORDERED", received: "RECEIVED", "already have": "HAVE", have: "HAVE",
};

/** A real calendar day (2026-02-30 isn't), or undefined so one bad cell can't sink the whole paste. */
function realDay(y: string, mo: string, d: string): string | undefined {
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : undefined;
}

function parseDate(s: string): string | undefined {
  const t = s.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return realDay(iso[1]!, iso[2]!, iso[3]!);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);  // US m/d/y
  if (m) {
    const [, mo = "", d = "", yr = ""] = m;
    return realDay(yr.length === 2 ? `20${yr}` : yr, mo, d);
  }
  return undefined;
}

/** Turn pasted cells + a column mapping into rows. Rows without a name are dropped. */
export function toRows(matrix: string[][], mapping: (PasteField | null)[], defaultVendor = ""): NewRow[] {
  const out: NewRow[] = [];
  for (const values of matrix) {
    const o: Partial<Record<PasteField, string>> = {};
    mapping.forEach((f, k) => { const v = values[k]; if (f && v && !o[f]) o[f] = v; });
    if (!o.title?.trim()) continue;
    const qty = o.quantity ? parseFloat(o.quantity.replace(/,/g, "")) : NaN;
    const row: NewRow = { title: o.title.trim() };
    // The server refuses a zero/negative quantity or a negative price for the
    // whole batch, so such a cell is left out and noted on its row instead.
    const leftOut: string[] = [];
    if (Number.isFinite(qty)) { if (qty > 0) row.quantity = qty; else leftOut.push(`quantity ${o.quantity!.trim()}`); }
    const unit = parseCents(o.unit_price);
    if (unit !== null && unit < 0) leftOut.push(`unit price ${o.unit_price!.trim()}`); else if (unit !== null) row.unit_price_cents = unit;
    const tax = parseCents(o.tax_shipping); if (tax !== null) row.tax_shipping_cents = tax;
    const total = parseCents(o.total);
    if (total !== null && total < 0) leftOut.push(`total ${o.total!.trim()}`); else if (total !== null) row.total_estimate_cents = total;
    const vendor = (o.vendor ?? "").trim() || defaultVendor.trim(); if (vendor) row.vendor = vendor;
    if (o.part_number) row.part_number = o.part_number;
    if (o.product_url) row.product_url = o.product_url;
    if (o.priority) row.priority = ({ high: "HIGH", medium: "Medium", low: "Low" } as Record<string, string>)[o.priority.trim().toLowerCase()];
    if (o.needed_by) row.needed_by = parseDate(o.needed_by);
    if (o.date_needed_raw) row.date_needed_raw = o.date_needed_raw.trim().slice(0, 100);
    if (o.funding_source) row.funding_source = o.funding_source.trim().slice(0, 100);
    const note = leftOut.length ? `Pasted ${leftOut.join(", ")} left out: check it.` : "";
    if (o.notes || note) row.notes = [o.notes, note].filter(Boolean).join(" ");
    if (o.status) { const s = AIRTABLE_STATUS[o.status.trim().toLowerCase()]; if (s) row.status = s; }
    out.push(row);
  }
  return out;
}
