import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HistoryScreen } from "../../src/modules/vault/screens/HistoryScreen";

interface Opts {
  // null → folders query never resolves (stays loading). Otherwise resolves
  // with this error (or empty data on null-error).
  foldersError?: any;
  foldersHang?: boolean;
}

function mockClient(opts: Opts = {}): SupabaseClient {
  const { foldersError = null, foldersHang = false } = opts;
  const okChain = (data: any[]) => ({
    select: () => ({
      eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data, error: null }) }; return node; } }),
    }),
  });
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "v", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "locks") {
        // useLocks: .select().is().order().range()
        return {
          select: () => ({
            is: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }),
          }),
        };
      }
      if (table === "folders") {
        if (foldersHang) {
          return { select: () => ({ eq: () => ({ order: () => { const node: any = { order: () => node, range: () => new Promise(() => {}) }; return node; } }) }) };
        }
        if (foldersError) {
          return { select: () => ({ eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: null, error: foldersError }) }; return node; } }) }) };
        }
        return okChain([]);
      }
      return okChain([]);
    }),
    rpc: (_name: string) => Promise.resolve({ data: false, error: null }),
  } as any;
}

describe("<HistoryScreen>", () => {
  it("shows 'Pick a folder' empty state initially", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/pick a folder/i)).toBeInTheDocument());
    expect(screen.getByText(/pick a file to see its history/i)).toBeInTheDocument();
  });

  it("V18: shows a folders loading state distinct from the empty copy", async () => {
    render(
      <SupabaseAuthProvider client={mockClient({ foldersHang: true })}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/loading folders/i)).toBeInTheDocument());
  });

  it("V18: surfaces a folders query error", async () => {
    render(
      <SupabaseAuthProvider client={mockClient({ foldersError: { message: "folders boom" } })}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/folders boom/i)).toBeInTheDocument());
  });
});
