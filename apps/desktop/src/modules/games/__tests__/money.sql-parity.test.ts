import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BET_FRACTION, MIN_BET, STARTING_BUDGET } from "../money";
import { MULTIPLIER_CENTS, RISKS, ROW_OPTIONS } from "../games/plinko/logic";

// The money rules and the plinko payout tables exist twice: once in TS so the
// cabinet can grey out chips and draw the board without a round trip, and once
// in SQL, which is the copy that actually moves chips. Comments cross-
// referencing each other are the house convention, but a comment has never
// stopped a number drifting. This reads the migration and pins them together.
//
// If this test fails, the SQL is right and the TS is wrong — the server owns
// the money — unless you meant to change both.

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../infra/pdm-supabase/supabase/migrations/20260825000000_games_money_plinko.sql",
);
const sql = readFileSync(MIGRATION, "utf8");

describe("plinko payout tables", () => {
  const seeded = new Map<string, number[]>();
  for (const m of sql.matchAll(
    /\((\d+)::smallint,\s*'(\w+)',\s*array\[([\d,\s]+)\]\)/g,
  )) {
    seeded.set(`${m[1]}:${m[2]}`, m[3]!.split(",").map((n) => Number(n.trim())));
  }

  it("seeds every board the client knows how to draw", () => {
    expect(seeded.size).toBe(ROW_OPTIONS.length * RISKS.length);
  });

  it("seeds the same multipliers the client renders", () => {
    for (const rows of ROW_OPTIONS) {
      for (const risk of RISKS) {
        expect(seeded.get(`${rows}:${risk}`)).toEqual([...MULTIPLIER_CENTS[rows][risk]]);
      }
    }
  });
});

describe("bet cap", () => {
  it("uses the same fraction and table minimum as money.ts", () => {
    // games.max_bet: least(balance, greatest(5, (balance * 5) / 100))
    const m = sql.match(
      /least\(p_balance,\s*greatest\((\d+)::bigint,\s*\(p_balance \* (\d+)\) \/ (\d+)\)\)/,
    );
    expect(m, "games.max_bet body not found — did the function get rewritten?").toBeTruthy();
    const [, minBet, numerator, denominator] = m!;
    expect(Number(minBet)).toBe(MIN_BET);
    expect(Number(numerator) / Number(denominator)).toBe(BET_FRACTION);
  });

  it("seeds budgets at the same starting balance", () => {
    const m = sql.match(/balance\s+bigint not null default (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(STARTING_BUDGET);
  });
});

describe("payout rounding", () => {
  it("uses the same integer round-half-up form as payoutChips", () => {
    // Both sides must be `(stake * cents + 50) / 100` on integers. Anything
    // that routes through a float or a numeric divide can disagree by a chip
    // on the half-way cases, and a payout that doesn't match what the server
    // wrote is a bug report every time.
    expect(sql).toMatch(/v_payout\s*:=\s*\(p_stake \* v_cents \+ 50\) \/ 100;/);
  });
});
