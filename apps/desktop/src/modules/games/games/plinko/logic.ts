// Plinko — the pure part. Board shape, payout tables, and the arithmetic that
// turns a dropped ball's path into chips.
//
// WHO DECIDES WHERE THE BALL LANDS
// --------------------------------
// Not this file. The path comes from the server (games.plinko_drop), which
// generates it, resolves the bucket, and moves the money in one transaction —
// so the client is only ever ANIMATING a result that has already been paid.
// That matters more here than it did for the arcade games: plinko spends the
// subteam's shared budget, and an outcome the client picked would be an
// outcome the client could pick again. Everything below is presentation and
// board maths; nothing in it can change what a drop was worth.
//
// WHY MULTIPLIERS ARE INTEGER HUNDREDTHS
// --------------------------------------
// Money has to come out the same on both sides of the wire. A float multiplier
// doesn't: JS binary floats and Postgres `numeric` disagree on exactly the
// half-chip cases that rounding then amplifies to a whole chip. Storing 0.93x
// as 93 keeps `stake * cents` an exact integer in both languages, so
// payoutChips() here and the SQL always agree to the chip.
//
// THE TABLES
// ----------
// Every board returns ~99% — deliberately close to blackjack's ~1.1% chart
// edge, so picking plinko is a choice about VARIANCE rather than a worse deal.
// Multipliers rise monotonically from the centre outward (the middle is always
// the bad bucket) and the top of each table is capped far below a real casino's
// 1000x: one bet is at most 5% of the subteam budget, so a 1000x would hand a
// single lucky drop fifty times everything the team owns. 50x on the 16-row
// high board is the ceiling — about 2.5x the budget, once in 32,768 drops.
//
// ⚠ These tables are duplicated into games.plinko_payouts by the migration and
//   pinned to it by __tests__/money.sql-parity.test.ts. The DB copy is the one
//   that pays; this copy exists so the board can be drawn before any drop.

export const ROW_OPTIONS = [8, 12, 16] as const;
export type Rows = (typeof ROW_OPTIONS)[number];

export const RISKS = ["low", "med", "high"] as const;
export type Risk = (typeof RISKS)[number];

export const RISK_LABEL: Record<Risk, string> = { low: "LOW", med: "MEDIUM", high: "HIGH" };

/** Payout per bucket, in hundredths of the stake, left edge to right edge. */
export const MULTIPLIER_CENTS: Record<Rows, Record<Risk, readonly number[]>> = {
  8: {
    low: [220, 170, 120, 93, 72, 93, 120, 170, 220],
    med: [600, 300, 150, 75, 36, 75, 150, 300, 600],
    high: [1200, 430, 150, 55, 21, 55, 150, 430, 1200],
  },
  12: {
    low: [300, 230, 180, 140, 110, 87, 73, 87, 110, 140, 180, 230, 300],
    med: [1200, 670, 370, 210, 110, 64, 38, 64, 110, 210, 370, 670, 1200],
    high: [2600, 1200, 520, 240, 110, 47, 15, 47, 110, 240, 520, 1200, 2600],
  },
  16: {
    low: [400, 320, 260, 200, 160, 130, 100, 84, 74, 84, 100, 130, 160, 200, 260, 320, 400],
    med: [1800, 1100, 680, 420, 260, 160, 99, 61, 38, 61, 99, 160, 260, 420, 680, 1100, 1800],
    high: [5000, 2500, 1300, 660, 330, 170, 86, 44, 21, 44, 86, 170, 330, 660, 1300, 2500, 5000],
  },
};

export function multiplierCents(rows: Rows, risk: Risk, bucket: number): number {
  return MULTIPLIER_CENTS[rows][risk][bucket] ?? 0;
}

/** A path is one L/R decision per row; the bucket is how many went right. */
export function bucketOf(path: string): number {
  let right = 0;
  for (const c of path) if (c === "R") right++;
  return right;
}

export function isValidPath(path: string, rows: Rows): boolean {
  return path.length === rows && /^[LR]+$/.test(path);
}

/** Chips paid for a stake landing on `cents`. Pure integer arithmetic —
 *  `+50` before the divide is round-half-up, matching Postgres round(). */
export function payoutChips(stake: number, cents: number): number {
  return Math.floor((stake * cents + 50) / 100);
}

/** Binomial chance of landing in `bucket`, computed multiplicatively so the
 *  16-row coefficients never leave float range. */
export function bucketChance(rows: Rows, bucket: number): number {
  let c = 1;
  for (let i = 0; i < bucket; i++) c = (c * (rows - i)) / (i + 1);
  return c / 2 ** rows;
}

/** Expected return per chip staked on this board. ~0.99 everywhere. */
export function rtp(rows: Rows, risk: Risk): number {
  let total = 0;
  for (let k = 0; k <= rows; k++) {
    total += bucketChance(rows, k) * (multiplierCents(rows, risk, k) / 100);
  }
  return total;
}

/** Where the ball sits after each row, in bucket-widths from the left edge.
 *  Starts at the centre and drifts half a slot per bounce, so the last entry
 *  is the bucket index itself. */
export function ballTrack(path: string): number[] {
  const rows = path.length;
  const track = [rows / 2];
  let right = 0;
  for (let i = 0; i < rows; i++) {
    if (path[i] === "R") right++;
    track.push((rows - i - 1) / 2 + right);
  }
  return track;
}

/** Peg x-positions per row, in the same bucket-width units as ballTrack. */
export function pegRows(rows: Rows): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j <= i; j++) row.push((rows - i) / 2 + j);
    out.push(row);
  }
  return out;
}
