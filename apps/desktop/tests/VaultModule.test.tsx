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

  it("shows the Vault sub-navigation when authenticated", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    };
    // BrowseScreen (the default sub-screen) calls useVaults/useFolders/useLocks.
    // Provide minimal mock chains so they resolve cleanly.
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signInWithPassword: vi.fn(),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "vaults") return { select: () => Promise.resolve({ data: [], error: null }) };
        if (table === "folders") return { select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) };
        if (table === "files") return { select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) };
        if (table === "locks") return { select: () => ({ is: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) };
        if (table === "user_roles") return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }),
      rpc: (_name: string) => Promise.resolve({ data: false, error: null }),
    } as any;
    render(
      <SupabaseAuthProvider client={c}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /who has what/i })).toBeInTheDocument();
  });
});
