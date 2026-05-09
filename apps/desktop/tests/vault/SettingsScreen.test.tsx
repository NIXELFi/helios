import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SettingsScreen } from "../../src/modules/vault/screens/SettingsScreen";

// Mock Tauri dialog so tests don't require a real Tauri runtime.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue("/Users/me/SDM26-Vault"),
}));

function mockClient(role: string | null = "editor", isAdmin = false): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "test@sdm.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: role ? { role } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

describe("<SettingsScreen>", () => {
  beforeEach(() => localStorage.clear());

  it("renders signed-in email and role", async () => {
    render(
      <SupabaseAuthProvider client={mockClient("editor")}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("test@sdm.com")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("editor")).toBeInTheDocument());
  });

  it("sign out button calls client.auth.signOut", async () => {
    const c = mockClient("editor");
    render(
      <SupabaseAuthProvider client={c}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /sign out/i });
    await act(async () => { fireEvent.click(btn); });
    expect(c.auth.signOut).toHaveBeenCalled();
  });

  it("pick vault folder button stores path in localStorage", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    const pickBtn = await screen.findByRole("button", { name: /pick vault folder/i });
    await act(async () => { fireEvent.click(pickBtn); });
    await waitFor(() =>
      expect(localStorage.getItem("helios.vault.localFolder")).toBe("/Users/me/SDM26-Vault"),
    );
    expect(await screen.findByText("/Users/me/SDM26-Vault")).toBeInTheDocument();
  });
});
