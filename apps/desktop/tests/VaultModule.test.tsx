import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import { VaultModule } from "../src/modules/vault";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(session: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithPassword: vi.fn(),
    },
  } as any;
}

describe("<VaultModule>", () => {
  it("shows the LoginPane when not authenticated", async () => {
    render(
      <SupabaseAuthProvider client={mockClient(null)}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });
  });

  it("shows the VaultHome placeholder when authenticated", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    };
    render(
      <SupabaseAuthProvider client={mockClient(session)}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/vault/i)).toBeInTheDocument();
    });
    // The placeholder home contains a hint about Plan 4 / coming soon.
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
