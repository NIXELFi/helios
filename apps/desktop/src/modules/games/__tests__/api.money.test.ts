import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@helios/auth";
import {
  bjDeal, bjDouble, bjHit, bjStand, dropBall, fetchAllTime, fetchBudget,
  fetchBudgetStandings, fetchBudgets, fetchLedger, forfeitOpenBet, isMoney, isRated,
} from "../api";

// Stub shaped like the games data layer: client.schema("games").from(...) for
// tables/views, .rpc(...) for functions.
function stubClient(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
  const from = vi.fn().mockReturnValue(chain);
  const rpc = vi.fn().mockResolvedValue(result);
  const schema = vi.fn().mockReturnValue({ from, rpc });
  return { client: { schema } as unknown as SupabaseClient, from, rpc, chain };
}

describe("isMoney", () => {
  it("marks plinko as spending the shared budget", () => {
    expect(isMoney("plinko")).toBe(true);
  });

  it("leaves the arcade games alone", () => {
    expect(isMoney("snake")).toBe(false);
    expect(isMoney("2048")).toBe(false);
  });
});

describe("fetchBudget", () => {
  it("reads the caller's subteam budget and its live cap", async () => {
    const { client, rpc } = stubClient({
      data: [{ budget_subteam: "Aero", budget_balance: 8420, budget_max_bet: 421 }],
      error: null,
    });
    const budget = await fetchBudget(client);
    expect(rpc).toHaveBeenCalledWith("my_budget");
    expect(budget).toEqual({ subteam: "Aero", balance: 8420, maxBet: 421 });
  });

  it("throws rather than inventing a balance", async () => {
    const { client } = stubClient({ data: null, error: { message: "nope" } });
    await expect(fetchBudget(client)).rejects.toThrow(/nope/);
  });
});

describe("dropBall", () => {
  const OK = {
    data: [{
      drop_path: "LRLRLRLR", drop_bucket: 4, drop_multiplier: 36,
      drop_payout: 18, drop_net: -32, new_balance: 9968, new_max_bet: 498,
      was_replay: false,
    }],
    error: null,
  };

  it("sends the board, stake and nonce to games.plinko_drop", async () => {
    const { client, rpc } = stubClient(OK);
    await dropBall(client, { rows: 8, risk: "med", stake: 50 }, "nonce-1");
    expect(rpc).toHaveBeenCalledWith("plinko_drop", {
      p_rows: 8, p_risk: "med", p_stake: 50, p_nonce: "nonce-1",
    });
  });

  it("returns the server's ball, not a locally rolled one", async () => {
    const { client } = stubClient(OK);
    const drop = await dropBall(client, { rows: 8, risk: "med", stake: 50 }, "n");
    expect(drop).toEqual({
      path: "LRLRLRLR", bucket: 4, multiplierCents: 36, payout: 18, net: -32,
      balance: 9968, maxBet: 498, replay: false,
    });
  });

  it("rejects a stake that isn't whole chips before hitting the network", async () => {
    const { client, rpc } = stubClient(OK);
    await expect(dropBall(client, { rows: 8, risk: "med", stake: 2.5 }, "n")).rejects.toThrow(/whole/i);
    await expect(dropBall(client, { rows: 8, risk: "med", stake: 0 }, "n")).rejects.toThrow(/whole/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires a nonce, so a retry can never roll a second ball", async () => {
    const { client, rpc } = stubClient(OK);
    await expect(dropBall(client, { rows: 8, risk: "med", stake: 5 }, "")).rejects.toThrow(/nonce/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal when a stake is over the cap", async () => {
    const { client } = stubClient({
      data: null,
      error: { message: "one bet cannot exceed 5% of the budget (max 421 chips, balance 8420)" },
    });
    await expect(dropBall(client, { rows: 8, risk: "med", stake: 999 }, "n")).rejects.toThrow(/5%/);
  });
});

describe("money leaderboards", () => {
  it("routes a money game's board to the ledger views, not the score views", async () => {
    const { client, from } = stubClient({ data: [], error: null });
    await fetchAllTime(client, "plinko");
    expect(from).toHaveBeenCalledWith("leaderboard_money_alltime");
  });

  it("still routes an arcade game to the score views", async () => {
    const { client, from } = stubClient({ data: [], error: null });
    await fetchAllTime(client, "snake");
    expect(from).toHaveBeenCalledWith("leaderboard_alltime");
  });

  it("keeps a losing member on the board — negative is a real result here", async () => {
    const { client } = stubClient({
      data: [
        { user_id: "a", display_name: "Ann", subteam: "Aero", best: 240 },
        { user_id: "b", display_name: "Bob", subteam: "Aero", best: -1180 },
      ],
      error: null,
    });
    const rows = await fetchAllTime(client, "plinko");
    expect(rows.map((r) => [r.displayName, r.best, r.rank])).toEqual([
      ["Ann", 240, 1],
      ["Bob", -1180, 2],
    ]);
  });
});

describe("fetchBudgets", () => {
  it("ranks subteams by chips on hand", async () => {
    const { client, from } = stubClient({
      data: [
        { subteam: "Chassis", balance: 7100, staked: 5000, returned: 2100, bets: 40 },
        { subteam: "Aero", balance: 12400, staked: 9000, returned: 11400, bets: 61 },
      ],
      error: null,
    });
    const rows = await fetchBudgets(client);
    expect(from).toHaveBeenCalledWith("leaderboard_budgets");
    expect(rows.map((r) => [r.subteam, r.balance, r.rank])).toEqual([
      ["Aero", 12400, 1],
      ["Chassis", 7100, 2],
    ]);
  });
});

describe("fetchLedger", () => {
  it("maps ledger rows, keeping the plinko detail for the display", async () => {
    const { client, from } = stubClient({
      data: [{
        id: "1", subteam: "Aero", user_id: "a", display_name: "Ann", game_id: "plinko",
        stake: 100, payout: 0, net: -100, balance_after: 9900,
        detail: { path: "LLLLLLLL", bucket: 0, rows: 8, risk: "high", multiplier_cents: 1200 },
        created_at: "2026-08-25T10:00:00Z",
      }],
      error: null,
    });
    const rows = await fetchLedger(client, 50);
    expect(from).toHaveBeenCalledWith("ledger_recent");
    expect(rows[0]).toMatchObject({
      subteam: "Aero", displayName: "Ann", gameId: "plinko",
      stake: 100, payout: 0, net: -100, multiplierCents: 1200,
    });
  });
});

describe("fetchBudgetStandings (casino standings)", () => {
  it("ranks subteams by chips on hand, not by placement points", async () => {
    // The arcade normalises across games with placement points because a 2048
    // best and a Snake best aren't comparable. The casino has no such problem:
    // every casino game spends the same pot, so the pot IS the score.
    const { client } = stubClient({
      data: [
        { subteam: "Chassis", balance: 7100, staked: 5000, returned: 2100, bets: 40 },
        { subteam: "Aero", balance: 12400, staked: 9000, returned: 11400, bets: 61 },
      ],
      error: null,
    });
    const rows = await fetchBudgetStandings(client);
    expect(rows).toEqual([
      { subteam: "Aero", total: 12400, perGame: {}, note: "9,000 staked · 61 bets" },
      { subteam: "Chassis", total: 7100, perGame: {}, note: "5,000 staked · 40 bets" },
    ]);
  });

  it("keeps a subteam that has never played, sitting on its full budget", async () => {
    const { client } = stubClient({
      data: [{ subteam: "DAQ", balance: 10000, staked: 0, returned: 0, bets: 0 }],
      error: null,
    });
    const rows = await fetchBudgetStandings(client);
    expect(rows[0]).toEqual({
      subteam: "DAQ", total: 10000, perGame: {}, note: "untouched",
    });
  });
});

describe("blackjack is a money game and nothing else", () => {
  it("spends the shared budget and is NOT rated", () => {
    // The two flags are independent, not a spectrum, and blackjack is now on
    // exactly one of them: chips are the whole scoreboard. isRated must stay
    // false or the module fetches a rating the cabinet no longer takes and
    // submits a session nothing consumes.
    expect(isMoney("blackjack")).toBe(true);
    expect(isRated("blackjack")).toBe(false);
    expect(isMoney("plinko")).toBe(true);
    expect(isRated("plinko")).toBe(false);
  });

  it("has no rated games left at all", () => {
    // The ladder is switched off, not half-wired. If a game is ever put back
    // on it, that is a deliberate change and this test should be the thing
    // that makes someone say so out loud.
    const everyGame = ["snake", "breakout", "flappy", "2048", "blackjack", "plinko"] as const;
    expect(everyGame.filter((g) => isRated(g))).toEqual([]);
  });

  it("shows chips on its boards", async () => {
    // Boards were already money-routed; with the ladder off there is no other
    // candidate, and this pins that the ratings board is not reachable.
    const { client, from } = stubClient({ data: [], error: null });
    await fetchAllTime(client, "blackjack");
    expect(from).toHaveBeenCalledWith("leaderboard_money_alltime");
  });
});

describe("server-dealt blackjack", () => {
  const OPEN_ROW = {
    bj_bet_id: "b1", bj_state: "player",
    bj_player: [{ rank: "9", suit: "S" }, { rank: "5", suit: "H" }],
    bj_dealer: [{ rank: "K", suit: "D" }],
    bj_stake: 100, bj_outcome: null, bj_payout: null,
    new_balance: 9900, new_max_bet: 495,
    bj_cards_left: 178, bj_reshuffled: false, was_replay: false,
  };

  it("deals through games.bj_deal and returns the server's table", async () => {
    const { client, rpc } = stubClient({ data: [OPEN_ROW], error: null });
    const table = await bjDeal(client, 100, "n1");
    expect(rpc).toHaveBeenCalledWith("bj_deal", { p_stake: 100, p_nonce: "n1" });
    expect(table).toMatchObject({
      betId: "b1", state: "player", stake: 100, outcome: null, payout: null,
      balance: 9900, maxBet: 495, cardsLeft: 178, reshuffled: false, replay: false,
    });
    expect(table.player).toHaveLength(2);
    // While the hand is live the dealer array holds ONLY the up card — the
    // hole card must not exist client-side at all.
    expect(table.dealer).toHaveLength(1);
  });

  it("hands back a hand the server already settled (a natural)", async () => {
    const { client } = stubClient({
      data: [{
        ...OPEN_ROW, bj_state: "settled",
        bj_player: [{ rank: "A", suit: "S" }, { rank: "K", suit: "H" }],
        bj_dealer: [{ rank: "9", suit: "D" }, { rank: "7", suit: "C" }],
        bj_outcome: "blackjack", bj_payout: 250, new_balance: 10150,
      }],
      error: null,
    });
    const table = await bjDeal(client, 100, "n1");
    expect(table.state).toBe("settled");
    expect(table.outcome).toBe("blackjack");
    expect(table.payout).toBe(250);
    expect(table.dealer).toHaveLength(2);
  });

  it("rejects a stake that isn't whole chips before hitting the network", async () => {
    const { client, rpc } = stubClient({ data: [OPEN_ROW], error: null });
    await expect(bjDeal(client, 2.5, "n")).rejects.toThrow(/whole/i);
    await expect(bjDeal(client, 0, "n")).rejects.toThrow(/whole/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires a nonce, so a retry can never deal a second hand", async () => {
    const { client, rpc } = stubClient({ data: [OPEN_ROW], error: null });
    await expect(bjDeal(client, 100, "")).rejects.toThrow(/nonce/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hits and stands through their RPCs with the bet id", async () => {
    const { client, rpc } = stubClient({ data: [OPEN_ROW], error: null });
    await bjHit(client, "b1", "n2");
    expect(rpc).toHaveBeenCalledWith("bj_hit", { p_bet_id: "b1", p_nonce: "n2" });
    await bjStand(client, "b1", "n3");
    expect(rpc).toHaveBeenCalledWith("bj_stand", { p_bet_id: "b1", p_nonce: "n3" });
  });

  it("doubles through games.bj_double and returns the settled, doubled table", async () => {
    const { client, rpc } = stubClient({
      data: [{
        ...OPEN_ROW, bj_state: "settled", bj_stake: 200,
        bj_player: [
          { rank: "9", suit: "S" }, { rank: "2", suit: "H" }, { rank: "K", suit: "C" },
        ],
        bj_dealer: [{ rank: "K", suit: "D" }, { rank: "9", suit: "S" }],
        bj_outcome: "win", bj_payout: 400, new_balance: 10100,
      }],
      error: null,
    });
    const table = await bjDouble(client, "b1", "n4");
    expect(rpc).toHaveBeenCalledWith("bj_double", { p_bet_id: "b1", p_nonce: "n4" });
    // The doubled stake and the server-computed payout come back together —
    // there is nothing for the client to report.
    expect(table.state).toBe("settled");
    expect(table.stake).toBe(200);
    expect(table.payout).toBe(400);
    expect(table.player).toHaveLength(3);
  });

  it("surfaces the server's refusal when a hand is already open", async () => {
    const { client } = stubClient({
      data: null, error: { message: "a hand is already open (b1)" },
    });
    await expect(bjDeal(client, 100, "n")).rejects.toThrow(/already open/);
  });

  it("reports nothing when there was no hand left open to forfeit", async () => {
    const { client } = stubClient({ data: [], error: null });
    expect(await forfeitOpenBet(client, "blackjack")).toBeNull();
  });

  it("reports the stake lost when a hand was left open", async () => {
    const { client } = stubClient({
      data: [{ forfeited_id: "b9", forfeited_stake: 75 }], error: null,
    });
    expect(await forfeitOpenBet(client, "blackjack")).toEqual({ betId: "b9", stake: 75 });
  });
});
