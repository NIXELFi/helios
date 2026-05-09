import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WhoHasWhatScreen } from "../../src/modules/vault/screens/WhoHasWhatScreen";

function mockClient(rows: any[], isAdmin = false): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({ select: () => ({ is: () => Promise.resolve({ data: rows, error: null }) }) }),
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

describe("<WhoHasWhatScreen>", () => {
  it("shows empty state when no active locks", async () => {
    render(
      <SupabaseAuthProvider client={mockClient([])}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/nothing checked out/i)).toBeInTheDocument());
  });

  it("renders one row per active lock", async () => {
    const locks = [
      { id: "l1", file_id: "fileA", user_id: "alice", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
      { id: "l2", file_id: "fileB", user_id: "bob", acquired_at: "2026-01-02", released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/active checkouts/i)).toBeInTheDocument());
    expect(screen.getByText("fileA")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("fileB")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows Force unlock button on each row when admin", async () => {
    const locks = [
      { id: "l1", file_id: "fileA", user_id: "alice", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks, true)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /force unlock/i })).toBeInTheDocument());
  });

  it("hides Force unlock button when not admin", async () => {
    const locks = [
      { id: "l1", file_id: "fileA", user_id: "alice", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks, false)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("fileA")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /force unlock/i })).toBeNull();
  });
});
