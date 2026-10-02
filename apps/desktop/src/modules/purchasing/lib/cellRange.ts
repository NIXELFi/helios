// A rectangle of cells selected on the parts sheet (click and drag, or
// shift-click), and the status-bar figures for it, as in Excel or Airtable.
// Pure functions, no React.

export interface CellRange { a: [row: number, col: number]; b: [row: number, col: number] }

export const rangeBounds = (r: CellRange) => ({
  r0: Math.min(r.a[0], r.b[0]), r1: Math.max(r.a[0], r.b[0]),
  c0: Math.min(r.a[1], r.b[1]), c1: Math.max(r.a[1], r.b[1]),
});
export const inRange = (r: CellRange | null, row: number, col: number) => {
  if (!r) return false;
  const { r0, r1, c0, c1 } = rangeBounds(r);
  return row >= r0 && row <= r1 && col >= c0 && col <= c1;
};
export const rangeSize = (r: CellRange) => { const { r0, r1, c0, c1 } = rangeBounds(r); return (r1 - r0 + 1) * (c1 - c0 + 1); };

/** One selected cell: a dollar amount (cents), a plain number, or text (counted only when not empty). */
export type CellValue = { money: number } | { number: number } | { text: string } | null;

export interface RangeSummary {
  count: number;        // non-empty cells
  moneyCount: number;
  moneySum: number;     // cents
  numberCount: number;
  numberSum: number;
}

export function summarize(values: CellValue[]): RangeSummary {
  const s: RangeSummary = { count: 0, moneyCount: 0, moneySum: 0, numberCount: 0, numberSum: 0 };
  for (const v of values) {
    if (!v) continue;
    if ("money" in v) { s.moneyCount++; s.moneySum += v.money; s.count++; }
    else if ("number" in v) { s.numberCount++; s.numberSum += v.number; s.count++; }
    else if (v.text.trim()) s.count++;
  }
  s.numberSum = Math.round(s.numberSum * 1e6) / 1e6;   // 0.1 + 0.2 shows as 0.3
  return s;
}
