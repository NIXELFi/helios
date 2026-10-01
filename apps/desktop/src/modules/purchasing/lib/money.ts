// Money is integer cents everywhere, same as the purchasing schema.

/** "$1,234.56", "2.57", "(3.00)", "USD 9.26" -> cents. Blank or junk -> null. */
export function parseCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  // a typographic minus (U+2212) or dash pasted from a PDF or a web page is a minus
  let s = input.trim().replace(/[\u2212\u2012\u2013\u2014]/g, "-");
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/CR$/i.test(s)) { negative = true; s = s.slice(0, -2); }
  if (/\d-$/.test(s)) { negative = !negative; s = s.slice(0, -1); }   // "5.00-"
  s = s.replace(/[^0-9.\-]/g, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (!s || s === "." || !/^\d*\.?\d*$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return negative ? -cents : cents;
}

/** A typed amount: blank is "none" (null), anything else must read as money or it throws. */
export function requireCents(input: string | null | undefined, what = "amount"): number | null {
  if (!input?.trim()) return null;
  const cents = parseCents(input);
  if (cents === null) throw new Error(`"${input.trim()}" isn't a valid ${what}.`);
  return cents;
}

export function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Cents -> "12.34" for an editable cell. */
export function centsToInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

/** "+$0.62" / "-$0.62": for differences. */
export function fmtSigned(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return cents > 0 ? `+${fmtCents(cents)}` : fmtCents(cents);
}
