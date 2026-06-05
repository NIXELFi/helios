import { describe, expect, it, vi } from "vitest";
import { fetchAllTime, fetchSubteams, submitScore } from "../api";

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
  return { client: { schema } as unknown as import("@helios/auth").SupabaseClient, schema, from, insert, chain };
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

describe("fetchSubteams", () => {
  it("aggregates per-game subtotals into ranked totals", async () => {
    const { client } = stubClient({
      data: [
        { subteam: "Aero", game_id: "snake", subtotal: 25 },
        { subteam: "Aero", game_id: "2048", subtotal: 2048 },
        { subteam: "Chassis", game_id: "snake", subtotal: 15 },
      ],
      error: null,
    });
    const rows = await fetchSubteams(client);
    expect(rows).toEqual([
      { subteam: "Aero", total: 2073, perGame: { snake: 25, "2048": 2048 } },
      { subteam: "Chassis", total: 15, perGame: { snake: 15 } },
    ]);
  });
});
