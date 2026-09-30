// Money is integer cents everywhere, same as the purchasing schema.

/** "$1,234.56", "2.57", "(3.00)", "USD 9.26" -> cents. Blank or junk -> null. */
export function parseCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/CR$/i.test(s)) { negative = true; s = s.slice(0, -2); }
  s = s.replace(/[^0-9.\-]/g, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (!s || s === "." || !/^\d*\.?\d*$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return negative ? -cents : cents;
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
