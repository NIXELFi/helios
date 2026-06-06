import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// --- Tauri IPC mocks --------------------------------------------------------
// invoke("bridge_addin_active") returns this; everything else resolves null.
let addinActive = false;
const invokeMock = vi.fn((cmd: string) =>
  cmd === "bridge_addin_active" ? Promise.resolve(addinActive) : Promise.resolve(null),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [string])) }));

// Capture the bridge://addin-connected handler so the test can fire a connect.
let connectHandler: (() => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    if (name === "bridge://addin-connected") connectHandler = cb;
    return Promise.resolve(() => {
      connectHandler = null;
    });
  },
}));

import { useBridgeSync } from "../../src/modules/vault/data/useBridgeSync";

// Recording client: every table read goes through fetchAllRows, which calls
// .range() last. We record which tables were queried so a test can assert
// whether the structure/locks pulls ran.
let queriedTables: string[] = [];
function builder(table: string): Record<string, unknown> {
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    is: () => b,
    range: () => {
      queriedTables.push(table);
      return Promise.resolve({ data: [], error: null });
    },
  };
  return b;
}
function makeClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi
        .fn()
        .mockResolvedValue({
          data: { session: { access_token: "tok", user: { id: "u1", email: "e@x", user_metadata: {} } } },
          error: null,
        }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => builder(table),
  } as unknown as SupabaseClient;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <SupabaseAuthProvider client={makeClient()}>{children}</SupabaseAuthProvider>
);

const STRUCTURE_TABLES = ["vaults", "files", "folders"];
const structureQueried = () => STRUCTURE_TABLES.some((t) => queriedTables.includes(t));

describe("useBridgeSync add-in gating", () => {
  beforeEach(() => {
    queriedTables = [];
    addinActive = false;
    connectHandler = null;
    invokeMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT pull the vault structure when the add-in is not connected", async () => {
    addinActive = false;
    renderHook(() => useBridgeSync(), { wrapper });
    // Let the sign-in effect resolve (session restored → addinActive checked).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(structureQueried()).toBe(false);
  });

  it("pulls the vault structure when the add-in is connected", async () => {
    addinActive = true;
    renderHook(() => useBridgeSync(), { wrapper });
    await waitFor(() => expect(structureQueried()).toBe(true));
  });

  it("pulls immediately when the add-in (re)connects via the event", async () => {
    addinActive = false;
    renderHook(() => useBridgeSync(), { wrapper });
    await waitFor(() => expect(connectHandler).not.toBeNull());
    expect(structureQueried()).toBe(false); // idle: nothing yet

    await act(async () => {
      connectHandler?.(); // add-in connected → bridge asks for a snapshot
      await Promise.resolve();
    });
    await waitFor(() => expect(structureQueried()).toBe(true));
  });

  it("skips the periodic refresh while the add-in stays idle", async () => {
    vi.useFakeTimers();
    addinActive = false;
    renderHook(() => useBridgeSync(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(310_000); // past the 5-min files interval
    });
    expect(structureQueried()).toBe(false);
  });
});
