import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@helios/auth";
import { fetchAllTime, fetchSubteams, submitScore } from "../api";
// fetchWeekly is a view-name alias over the same fetchBoard path as fetchAllTime — intentionally not separately tested.

// Minimal chainable stub for client.schema("games").from(...)
function stubClient(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
  const insert = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ ...chain, insert });
  const schema = vi.fn().mockReturnValue({ from });
  return { client: { schema } as unknown as SupabaseClient, schema, from, insert, chain };
}

describe("submitScore", () => {
  it("inserts game_id + score into games.scores", async () => {
    const { client, schema, from, insert } = stubClient({ data: null, error: null });
    await submitScore(client, "snake", 42);
    expect(schema).toHaveBeenCalledWith("games");
    expect(from).toHaveBeenCalledWith("scores");
    expect(insert).toHaveBeenCalledWith({ game_id: "snake", score: 42 });
  });

  it("throws on error", async () => {
    const { client } = stubClient({ data: null, error: { message: "nope" } });
    await expect(submitScore(client, "snake", 1)).rejects.toThrow(/nope/);
  });

  it("rejects non-integer or negative scores before hitting the network", async () => {
    const { client, insert } = stubClient({ data: null, error: null });
    await expect(submitScore(client, "snake", -1)).rejects.toThrow(/invalid/i);
    await expect(submitScore(client, "snake", 1.5)).rejects.toThrow(/invalid/i);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("fetchAllTime", () => {
  it("maps rows to ranked entries", async () => {
    const { client } = stubClient({
      data: [
        { user_id: "a", display_name: "Ann", subteam: "Aero", best: 25 },
        { user_id: "b", display_name: null, subteam: null, best: 15 },
      ],
      error: null,
    });
    const rows = await fetchAllTime(client, "snake");
    expect(rows).toEqual([
      { userId: "a", displayName: "Ann", subteam: "Aero", best: 25, rank: 1 },
      { userId: "b", displayName: "Unknown", subteam: null, best: 15, rank: 2 },
    ]);
  });
});

describe("fetchSubteams (Grand Prix placement scoring)", () => {
  it("awards placement points per game and sums them, not raw subtotals", async () => {
    const { client } = stubClient({
      data: [
        { subteam: "Aero", game_id: "snake", subtotal: 25 },
        { subteam: "Aero", game_id: "2048", subtotal: 2048 },
        { subteam: "Chassis", game_id: "snake", subtotal: 15 },
      ],
      error: null,
    });
    const rows = await fetchSubteams(client);
    // snake: Aero 1st (10), Chassis 2nd (8). 2048: Aero 1st (10, only entrant).
    expect(rows).toEqual([
      { subteam: "Aero", total: 20, perGame: { snake: 10, "2048": 10 } },
      { subteam: "Chassis", total: 8, perGame: { snake: 8 } },
    ]);
  });

  it("does not let a single high-scoring game dominate the standings", async () => {
    // Aero blows out 2048; Chassis blows out snake. Under raw-sum scoring whoever
    // won 2048 would win overall by a mile; under placement points it's a tie.
    const { client } = stubClient({
      data: [
        { subteam: "Aero", game_id: "2048", subtotal: 999999 },
        { subteam: "Aero", game_id: "snake", subtotal: 1 },
        { subteam: "Chassis", game_id: "2048", subtotal: 1 },
        { subteam: "Chassis", game_id: "snake", subtotal: 500 },
      ],
      error: null,
    });
    const rows = await fetchSubteams(client);
    // Each wins one game (10) and is runner-up in the other (8) -> 18 apiece.
    expect(rows.map((r) => [r.subteam, r.total])).toEqual([
      ["Aero", 18],
      ["Chassis", 18],
    ]);
  });

  it("gives tied subteams in a game equal placement points", async () => {
    const { client } = stubClient({
      data: [
        { subteam: "Aero", game_id: "snake", subtotal: 100 },
        { subteam: "Chassis", game_id: "snake", subtotal: 100 },
        { subteam: "DAQ", game_id: "snake", subtotal: 50 },
      ],
      error: null,
    });
    const rows = await fetchSubteams(client);
    // Aero & Chassis tie for 1st (10 each); DAQ is 3rd (6), 2nd place is skipped.
    expect(rows).toEqual([
      { subteam: "Aero", total: 10, perGame: { snake: 10 } },
      { subteam: "Chassis", total: 10, perGame: { snake: 10 } },
      { subteam: "DAQ", total: 6, perGame: { snake: 6 } },
    ]);
  });
});
