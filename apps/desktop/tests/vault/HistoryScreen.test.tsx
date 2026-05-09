import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HistoryScreen } from "../../src/modules/vault/screens/HistoryScreen";

function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "v", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "folders") return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
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
});
