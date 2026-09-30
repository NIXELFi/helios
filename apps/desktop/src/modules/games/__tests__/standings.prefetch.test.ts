import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@helios/auth";
import { prefetchBoards } from "../components/standings";

// "Plinko lags when you spam" (2026-09-02). Every drop reply bumped the
// standings refresh, and every refresh (a) re-pulled all fourteen boards and
// (b) asked the auth SERVER who the user was once per board, while holding
// supabase-auth's global session lock — the same lock every plinko_drop RPC
// needs for its bearer token. These pin the two halves of the fix: identity
// comes from the local session, and a money bump refetches one game's boards.

function stubClient() {
  const getUser = vi.fn(async () => {
    throw new Error("getUser is a network round trip under the auth lock — not allowed here");
  });
  const getSession = vi.fn(async () => ({
    data: { session: { user: { id: "user-1" } } },
    error: null,
  }));
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    // Awaitable at any point in the chain, like PostgREST's builder.
    chain.then = (onF: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(onF);
    return chain;
  });
  const schema = vi.fn(() => ({ from, rpc: vi.fn(async () => ({ data: [], error: null })) }));
  const client = { auth: { getUser, getSession }, schema } as unknown as SupabaseClient;
  return { client, getUser, getSession, from };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let token = 0;
beforeEach(() => {
  // A fresh token per test so the module-level cache never short-circuits.
  token += 100;
});

describe("standings prefetch", () => {
  it("identifies the user from the local session, never the auth server", async () => {
    const { client, getUser, getSession } = stubClient();
    prefetchBoards(client, token);
    await settle();
    expect(getUser).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalled();
  });

  it("warms every board when no game is named", async () => {
    const { client, from } = stubClient();
    prefetchBoards(client, token);
    await settle();
    // 6 games × (all-time + weekly) + one subteams board per room.
    expect(from).toHaveBeenCalledTimes(14);
  });

  it("re-pulls only the named game's boards on a money bump", async () => {
    const { client, from } = stubClient();
    prefetchBoards(client, token, "plinko");
    await settle();
    // plinko all-time + plinko weekly + the casino subteams board.
    expect(from).toHaveBeenCalledTimes(3);
  });
});
