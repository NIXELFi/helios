// Pure helpers behind the chart primitives, kept out of the components so they
// can be unit-tested without a DOM.

/**
 * A "nice" y-axis: the smallest step on the 1-2-5 ladder that yields at most
 * `maxTicks` gridlines, with the ceiling rounded up to a multiple of it. A
 * chart whose data peaks at 9 gets ticks at 0/5/10, never 0/4.5/9.
 */
export function niceTicks(maxValue: number, maxTicks = 4): { max: number; ticks: number[] } {
  const v = Math.max(1, maxValue);
  const ladder = [1, 2, 5];
  let step = 1;
  outer: for (let mag = 1; mag <= 1e9; mag *= 10) {
    for (const m of ladder) {
      step = m * mag;
      if (Math.ceil(v / step) <= maxTicks) break outer;
    }
  }
  const max = Math.ceil(v / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return { max, ticks };
}

/**
 * Which x labels to draw so none overlap: keep every `stride`-th label where
 * `stride` is the smallest that fits `labelWidth` into the slot. The LAST
 * column is always labelled (it is "this week" in every preset) and the
 * stride walks backwards from it so the newest labels are the ones kept.
 */
export function labelIndices(count: number, slotWidth: number, labelWidth: number): Set<number> {
  const out = new Set<number>();
  if (count <= 0) return out;
  const stride = Math.max(1, Math.ceil(labelWidth / Math.max(1, slotWidth)));
  for (let i = count - 1; i >= 0; i -= stride) out.add(i);
  return out;
}

/** Parse a YYYY-MM-DD day into a local-midnight Date, or null. */
export function parseDay(s: string | null | undefined): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Short axis label for a day key: "Sep 7". */
export function shortDay(s: string): string {
  const d = parseDay(s);
  if (!d) return s;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Fractional column position of a calendar day inside a strip of ISO weeks:
 * 0 = the left edge of the first week, `weeks.length` = the right edge of the
 * last. Null when the day falls outside the strip. Used to place milestone
 * diamonds on the baseline.
 */
export function dayToColumn(day: string, weekStarts: ReadonlyArray<string>): number | null {
  const d = parseDay(day);
  const first = parseDay(weekStarts[0] ?? null);
  if (!d || !first || weekStarts.length === 0) return null;
  const days = Math.round((d.getTime() - first.getTime()) / (24 * 60 * 60 * 1000));
  const col = days / 7;
  if (col < 0 || col > weekStarts.length) return null;
  return col;
}
