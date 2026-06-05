import { describe, expect, it } from "vitest";
import { GAMES } from "../registry";

// game_id values allowed by the games.scores check constraint — registry ids
// MUST stay in lockstep with the migration.
const DB_GAME_IDS = ["snake", "breakout", "flappy", "2048"];

describe("game registry", () => {
  it("has unique ids that match the DB check constraint", () => {
    const ids = GAMES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...DB_GAME_IDS].sort());
  });
  it("every game has a component, title, and icon", () => {
    for (const g of GAMES) {
      expect(g.component).toBeTypeOf("function");
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.icon).toBeTruthy();
    }
  });
});
